<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Each BYO database binding gets its own least-privilege database user

**Status:** Proposed — slice 1 of 5 landed with this document · **Issue:** #6438 ·
**Follows:** #6436 (binding ExternalSecrets, owner labels, declared-set prune, keyless parity), #6454
(the BYO marker and a namespace of its own per chart)

## Property

A bring-your-own chart's database binding receives a database user that exists for that binding alone:
it may connect to the environment's database and work inside a schema (Postgres) or database (MySQL)
of its own, and nothing else that this design grants (the limits of that are stated in §3). Its password lives in the environment's secret store under a key of its
own. The binding's ExternalSecret reads that key, and no BYO binding ever references the database's
administrative credential. Removing the binding's declaration removes its ExternalSecret and revokes
the user. The password never appears in a log, in a manifest or in SQL text sent to the server; only
its SCRAM-SHA-256 verifier does (§3).

A chart is code the user brought, so it gets the least privilege that works.

## Today

The table below was read from the code, not inferred from the issue.

| Cell | What a BYO credential facet (`username`/`password`) resolves to |
|---|---|
| AWS, password mode, Postgres or MySQL | the RDS **master** secret — `chartCredentialSecretOutputKey("database")` returns `rds_master_credentials_secret_name`, the same key the first-class lane's `credentialSecretOutputKey` uses |
| GCP, password mode | **unsatisfied**: the GCP template exports no `rds_master_credentials_secret_name`, so the resolver reports the facet and writes nothing |
| Azure, password mode | **unsatisfied**, for the same reason |
| any cloud, keyless (`ALETHIA_KEYLESS_DB_AUTH_ENABLED` and an `iam_auth` database) | **refused** with a stated reason; no password Secret exists (#6436) |

So the administrative credential reaches a BYO chart in exactly one cell today, AWS password mode, for
both engines. On GCP and Azure this design adds a capability, not a restriction.

## What already exists, and is reused

- **Generated passwords in the env's secret store.** Every cloud template has a `custom_secrets` tfvar
  that creates a secret with a generated password (`infra/templates/project/aws/modules/awssm-passgen`
  on AWS; the GCP and Azure templates declare the same object shape, built by `buildGCPSecrets`). It
  already honours rotation keepers (#4320): a per-entry `keepers` map on AWS, and the
  `custom_secret_keepers` map keyed by secret name on GCP and Azure. AWS and GCP export the
  created names as `custom_secret_names` (a map from the entry's key to the store's name); Azure exports
  only `custom_secret_ids`.
- **ESO can already read them on AWS.** The external-secrets operator's IRSA policy grants
  `GetSecretValue` on `<region-short>-<env>-<project>-*`, which is the prefix `awssm-passgen` writes
  under. No IAM change is needed there. The GCP and Azure operators' read scope was not checked for
  this document; slice 2 must confirm it covers the custom secrets before it claims those clouds.
- **The bootstrap Job** (`packages/core/manifests/bootstrap_job.go`). It already connects to each cloud's
  database as its administrator, from a credential that is materialised only for the duration of the
  run: the RDS master or the Cloud SQL built-in user through an ephemeral ExternalSecret, or on Azure a
  dedicated admin managed identity's Entra token. It renders the SQL with `alethia db-bootstrap` in an
  init container and applies it with `psql` or `mysql`. It has a deadline and a TTL. **Its cleanup does
  not carry over:** it is an ArgoCD PreSync hook, removed by hook delete policies, and the #6413 reaper
  (`reapStrandedBootstrapHooks`) selects only hooks of the apps Application with an exact rendered
  identity, and only once that Application is quiescent. A Job the runner applies itself is never
  selected by it, so the BYO users Job brings its own cleanup (§3).
- **The binding ExternalSecret and its prune** (#6436): one ExternalSecret per (chart namespace,
  workload, bound target), labelled with the binding marker and the environment's owner label, pruned
  against the set the configuration *declares*.

## Decision

Only what the slice table below marks **landed** exists in code: section 1's namer and section 4.
Everything else — the environment tag in section 1, and sections 2, 3, 5 and 6 — is the design the
later slices build to.

### 1. One identity per binding ExternalSecret, per environment

A per-binding user is keyed on the environment and on exactly the identity the binding ExternalSecret
already has: its namespace and its `BindingSecretName`. One namer derives both halves of the user's
identity, and every slice calls it (`manifests.ByoBindingDBUser`, `manifests.ByoBindingDBSecretKey`):

- **user** `alethia_byo_<h>`, and on Postgres a schema with the same name;
- **secret key** `alethia-byo-db-<h>` — the `custom_secrets` entry's key. Dashes only, because Azure
  Key Vault names allow no underscore;

where `<h>` is the first 12 hex characters of SHA-256 over `environment-id NUL namespace NUL
BindingSecretName`. The user is 24 characters, inside MySQL's 32-character limit and Postgres's 63. 48
bits makes a collision negligible, and the prefix keeps every per-binding user apart from the
platform's own roles (`alethia_app` and the administrators). An environment with no ID gets no user:
its database credential facets are unsatisfied.

The environment is in the hash so that two environments never derive the same user, even if they ever
reach one database server (a BYO-IaC module, an adopted instance). The name alone cannot say which
environment a user belongs to, so every user is also **tagged** with its environment when it is created
(Postgres `COMMENT ON ROLE`, which a non-`CREATEROLE` user cannot change; MySQL user `ATTRIBUTE`), and
the revocation sweep (§5) reads that tag.

A chart moved to another namespace (#6446) is therefore a new binding with a new user. The old user is
revoked like any removed binding, and its data is retained (§5).

### 2. The password is generated by tofu, in the store

The runner appends one `custom_secrets` entry per declared database binding: key
`ByoBindingDBSecretKey`, length 32, no special characters, and a keeper naming the user. Tofu then creates
the secret through the module every project secret already uses. The runner writes to no cloud API and
needs no new cloud permission. The declared set is computed from the configuration alone, as the
ExternalSecret keep set is, so a deploy that fails half way cannot delete a live binding's secret.

**Where the password exists.** In the store; in tofu state, because `random_password` keeps its result
there, as every existing `custom_secrets` entry does (the runner reads and writes that state through the
state proxy for the duration of a run); in the binding's k8s Secret; and briefly in the BYO users Job's
pod (§3). It is never in a manifest, the snapshot, a log line, or SQL text sent to the server.

**Only with the native secrets provider, today.** On AWS the template creates `custom_secrets` only when
the project's secrets provider is native (`custom_secrets.tf`); with any other provider the list is
empty, the per-binding key never exists, and the facet is unsatisfied (the resolver already reports it).
The per-binding secret belongs next to the environment's database whatever store the project's own
secrets use, so slice 2 feeds the entries through a list the provider gate does not empty, or, if it
cannot, states the unsatisfied case in the console. GCP and Azure are checked by the same slice.

The prefix `alethia-byo-db-` is reserved: a project secret named with it is refused, so the two
producers can never write one key.

### 3. The user is created by a BYO users Job, from the stored password

A second renderer next to `RenderBootstrapJob` renders a **BYO users Job** per database: the same
admin connection per cloud, the same deadline, TTL and security context. The SQL is rendered by
`alethia db-bootstrap --byo-users` from a list of users passed as arguments and passwords read from the
environment, and applied with the existing client containers. The passwords are alphanumeric by
construction (tofu generates them so), and the renderer refuses any other character.

**Where it runs, and what it holds.** The runner applies the Job itself, as it applies the binding
ExternalSecrets, because the hardened BYO project cannot carry it. It runs in a dedicated namespace the
runner creates for it (`alethia-byo-db-users`), which holds no workload. Every object it needs carries
`alethia.io/byo-db-users: "true"` and the environment's owner label:

- the admin credential, as for the existing bootstrap Job (an ExternalSecret on AWS/GCP, the federated
  admin ServiceAccount on Azure);
- **one ExternalSecret, and so one Secret, per declared user**, each holding only that user's password.
  The Job's pod reads each through its own `secretKeyRef`. No Secret holds two users' passwords, and
  none lives in a namespace any workload runs in.

**Cleanup is the runner's, because no hook policy or reaper covers a runner-applied Job.**

1. *On completion, either outcome.* The runner waits for the Job to reach Complete or Failed (bounded by
   its `activeDeadlineSeconds`), reads its result, and then deletes every credential-bearing object of
   the run — the admin ExternalSecret or ServiceAccount and each user's ExternalSecret — with a uid
   precondition and Foreground propagation, so each owned Secret goes first. This runs in a `defer`, so
   a render, wait or read error does not skip it. The Job itself holds no credential and is left to its
   TTL, so a failed run's logs stay readable.
2. *Before every run, a bounded sweep.* A run killed before step 1 (the runner process ended) leaves
   those objects behind. The next deploy, before it applies anything, lists the namespace's
   ExternalSecrets, Secrets and ServiceAccounts selected by the run label **and** this environment's
   owner label, re-checks both on each object, and deletes them uid-pinned, unless a BYO users Job of
   this environment is still active (then it leaves them, and does not start a second Job). It lists
   only that one namespace and those three kinds; it deletes nothing without both labels.
3. *Whatever no deploy follows.* A leftover from an environment that never deploys again would wait for
   that environment's next deploy, or its teardown, which removes the namespace's objects with its
   owner label. Until then the namespace holds no workload that could mount them.

**Three phases, so that revocation fails safe and never blocks provisioning.** `db-bootstrap` writes the
script only to the file named by `--out` (mode 0600; it refuses to run without one), never to stdout,
which in a pod is its log. The script carries its own transactions and is applied with
`psql -X -v ON_ERROR_STOP=1 -f`, not `--single-transaction`. A version floor runs before the three
phases (*Postgres 15 or newer*, below):

1. *Lockout*, committed on its own first: every revocation candidate (§5) is set `NOLOGIN`. Only after
   that has committed are its sessions terminated, so a reconnect cannot slip in between.
2. *Provision*, one transaction: a check that `PUBLIC` holds no `CREATE` on schema `public` (below), then
   every declared user. It applies for every declared user or for none. The result line is written
   right after it commits.
3. *Sweep*: each candidate's reassign and drop, each in a transaction of its own.

**Revocation runs only when the declared set is complete.** The declared set is the runner's: every
binding the configuration declares for the environment. If any binding failed to resolve or render on a
deploy, the set is incomplete. A binding missing from it would read as removed, and its user would be
revoked while the binding is still declared. On such a deploy the runner passes `--skip-revoke`. The
script then renders phase 2 only, with no lockout, no sweep and no `revocation-pending` lines. The
declared users that did resolve are still provisioned. This is the ExternalSecret prune's rule (§4): any
binding failure skips the prune.

A drop can be blocked by something the sweep cannot reach. A role that owns an object in another
database cannot be dropped, because `REASSIGN OWNED` and `DROP OWNED` act on the current database only.
While it still had LOGIN, a per-binding user could create such an object on purpose (below). That
candidate's transaction is rolled back alone, and psql reports a `WARNING` naming the role. The role
stays `NOLOGIN`, since its lockout committed in phase 1. The declared users are unaffected, because
phase 2 has already committed, and so are the other candidates. The run exits 0, and the next run
retries the drop.

**How the Job reports `Provisioned`, and a pending revocation.** After phase 2 commits, a statement
selects the declared users that now exist with LOGIN and the expected tag. The main container writes
that list, and nothing else, to its termination message. psql's `\o` points at the termination path
just before that statement, so no earlier output reaches it, and with `ON_ERROR_STOP` a failed run
never reaches it. After phase 3 the file is rewritten (`\o` truncates) with the same list, plus one
`revocation-pending:<role>` line for every candidate the sweep could not drop. A run that dies inside
phase 3 therefore still leaves phase 2's list behind. The runner reads the message from the pod's
`status.containerStatuses[].state.terminated.message`, through the API and never from logs (it is the
container's `terminationMessagePath`). It surfaces each pending line as a revocation that has not
finished: the role is locked out, but it still exists and still owns its objects. The
the pod's `status.containerStatuses[].state.terminated.message` through the API, never from logs). The
runner counts a user as provisioned only when **all three** hold: the Job's condition is Complete, the
user is in that message, and the user is in the set this deploy declared. A failed or timed-out Job,
an unreadable or malformed message, or a user missing from it means not provisioned; a Job failure is
also counted as a binding failure, so the binding prune is skipped for that deploy (§4). **A binding is
satisfiable only when its user is provisioned** (`ChartBindingPolicy.DBUsers.Provisioned`), so the
chart is never pointed at a user that does not exist yet.

What the SQL does for each declared user, every run, idempotently. Every identifier is quoted
(`quote_ident` / `format('%I')` on Postgres, backticks on MySQL), the database name included, which is
configured and may contain `-`; nothing relies on a name's shape.

**Postgres**

```sql
-- phase 0: RAISE unless server_version_num >= 150000 (Postgres 15 or newer, see below)
-- phase 2 opens with: RAISE if PUBLIC holds CREATE on schema public (see below)
CREATE ROLE "alethia_byo_<h>" LOGIN PASSWORD 'SCRAM-SHA-256$4096:<salt>$<stored>:<server>' CONNECTION LIMIT 20;
                                                      -- or ALTER ROLE … PASSWORD '<verifier>' if it exists
COMMENT ON ROLE "alethia_byo_<h>" IS 'alethia-env:<environment-id>';
GRANT "alethia_byo_<h>" TO CURRENT_USER;              -- managed admins are not superusers; REASSIGN needs it
GRANT CONNECT ON DATABASE "<db>" TO "alethia_byo_<h>";
-- re-adoption, only when a revoked user left a holder role (§5):
REASSIGN OWNED BY "alethia_byo_<h>_r" TO "alethia_byo_<h>";
DROP ROLE "alethia_byo_<h>_r";
CREATE SCHEMA IF NOT EXISTS "alethia_byo_<h>" AUTHORIZATION "alethia_byo_<h>";
ALTER ROLE "alethia_byo_<h>" IN DATABASE "<db>" SET search_path = "alethia_byo_<h>";
```

**The password is sent as a SCRAM-SHA-256 verifier, never as plaintext.** `db-bootstrap` computes the
verifier (RFC 5802/7677: a random salt, 4096 iterations) from the password it reads from its
environment, and the SQL carries only the verifier. A plaintext `PASSWORD '<pw>'` would reach the
server's statement log wherever `log_statement` covers DDL (common in RDS parameter groups and Cloud
SQL flags), and psql's error context in the Job's log. The verifier cannot be used to log in, and the
plaintext is never in the SQL file, an argument or a log line.

The verifier itself is in the SQL text. A server whose `log_statement` covers DDL (`ddl` or `all`) writes
it to the server log, and psql's error context can carry it into the Job's log when a statement fails. A
verifier does not authenticate. It does allow an offline guess at the password, which is not practical
against 32 random alphanumeric characters, but it is still credential material. Operators should not log
DDL on a server that hosts per-binding users, or should treat that log as sensitive.

No `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`, no membership in any role, no grant on
schema `public` or on any other schema.

**Postgres 15 or newer.** Before Postgres 15, `PUBLIC` may `CREATE` in schema `public` by default, so a
per-binding user could create objects outside its own schema. This design does not rewrite that default,
which would change what every first-class role may do. It sets a floor instead:

- Phase 0 refuses a server older than 15 before anything changes, with *per-binding database users
  need PostgreSQL 15 or newer*.
- Below 15 the runner does not run the BYO users Job, and the binding lane reports each per-binding
  credential facet unsatisfied with that same reason (#6466). Such a binding is never bound to the
  administrator.

An earlier revision of this design instead granted `CREATE` on `public` to the administrator and
`alethia_app`, then revoked it from `PUBLIC`. That preflight is removed. On a pre-15 server where the
administrator cannot manage `public` (RDS's `rdsadmin` owns it), it could only fail, and on any other it
rewrote a first-class default.

What remains is a check. Postgres 15 removed the default only for databases created on 15 or later. A
database carried over from an older major, by `pg_upgrade` or by a dump and restore, keeps its old ACL.
So phase 2 opens by refusing an environment database where `PUBLIC` still holds `CREATE` on `public`,
naming the cause, and changes nothing. Revoking it is the operator's decision.

What `PUBLIC` keeps by default — `CONNECT`
and `TEMP` on databases, `USAGE` on `public` — is unchanged, because revoking it would change what the
first-class services may do. It grants no access to any table.

**The limits of "nothing else".** This design grants a per-binding user nothing beyond the above. It
does not take away what `PUBLIC` holds on the rest of the server, so a per-binding user can also do the
following:

- `CONNECT` to every other database on the server whose `CONNECT` privilege `PUBLIC` still holds, which
  is the default;
- create large objects there, because that needs no grant;
- create objects in the `public` schema of any other database that was carried over from a Postgres
  older than 15 and still grants `PUBLIC` `CREATE` there, because the check covers the environment's
  database only.

It gains no access to another role's tables by any of these. An object created this way is out of
reach of `REASSIGN OWNED` and `DROP OWNED`, which is why phase 3 isolates each drop (above). A server
that must close these gaps needs `CONNECT` revoked from `PUBLIC` on its other databases, and `CREATE`
revoked from `PUBLIC` on any carried-over `public` schema. This design does neither.

**The administrator's membership.** The Job grants each per-binding role, and each holder role (§5), to
the administrator it connects as (`GRANT … TO CURRENT_USER`). The membership is permanent:

- it lasts until the role is dropped;
- holder roles are never dropped, by design, because they keep revoked data.

It is needed because managed administrators are not superusers. `REASSIGN OWNED`, `CREATE SCHEMA …
AUTHORIZATION` and dropping the role's objects all require the administrator to hold that role's
privileges. The grant runs in one direction only: the administrator can act as the per-binding role,
and the per-binding role gains nothing from the administrator.

**MySQL**

```sql
CREATE USER IF NOT EXISTS 'alethia_byo_<h>'@'%' IDENTIFIED WITH caching_sha2_password AS '<hash>'
  REQUIRE SSL WITH MAX_USER_CONNECTIONS 20 ATTRIBUTE '{"alethia_env": "<environment-id>"}';
ALTER USER 'alethia_byo_<h>'@'%' IDENTIFIED WITH caching_sha2_password AS '<hash>';
CREATE DATABASE IF NOT EXISTS `alethia_byo_<h>`;
GRANT <mysqlAppPrivileges> ON `alethia_byo_<h>`.* TO 'alethia_byo_<h>'@'%';
```

As on Postgres, the SQL carries a hash computed by `db-bootstrap`, not the password. If the MySQL slice
finds a cloud's server will not accept a precomputed `caching_sha2_password` string, it must say so in
its PR and turn statement logging's exposure into a stated limitation, not a silent one.

Scoped to a database of its own, with the DDL and DML set the keyless lane already grants
(`mysqlAppPrivileges`), never `*.*` or `GRANT OPTION`. MySQL has no schema below a database, so the
chart must be told which database to use, and no binding facet carries a database name today. **MySQL
is therefore a separate slice that adds a non-secret `database` facet.** Until it lands, a MySQL
binding in per-binding mode is unsatisfied with a stated reason, never bound to the administrator.

### 4. The binding ExternalSecret reads the user's own key

In per-binding mode a database credential facet renders a different ExternalSecret under the same name
(`RenderByoDBUserExternalSecret`):

```yaml
spec:
  target:
    name: <BindingSecretName>
    creationPolicy: Owner
    template:
      engineVersion: v2
      data:
        username: "alethia_byo_<h>"      # only the facets the binding asks for
        password: "{{ .password }}"
  data:
    - secretKey: password
      remoteRef:
        key: <custom_secret_names[alethia-byo-db-<h>]>
```

The user name is not secret and is written as a literal; the password is read from the binding's own
key, which the resolver takes from the tofu output that names it. The administrative output
(`rds_master_credentials_secret_name`) is not read at all in this mode. A facet whose user or key is
missing is reported and not written: no value-path patch, no ExternalSecret. `connection_string` is
unsatisfiable here, as it is on the administrative path.

The object carries `alethia.io/byo-binding-source: db-user` as well as the marker and owner label. The
prune keeps a declared database binding **only when the live object carries that label**. Turning the
mode on therefore withdraws every ExternalSecret an earlier deploy pointed at the administrative
credential, even one still declared. A per-binding ExternalSecret from an earlier deploy is kept when
this deploy's Job fails, because the existing rule (any binding failure skips the prune) still
applies.

### 5. Revocation

Removing a binding's declaration, detaching its chart, a refusal (#6439) or a move (#6446) all take the
binding out of the declared set. The next deploy then does the following:

1. **tofu** drops its `custom_secrets` entry and deletes the secret (`recovery_window_in_days = 0`);
2. **the binding prune** deletes its ExternalSecret, and with it the k8s Secret it owns (#6436);
3. **the BYO users Job** revokes every user that is **tagged with this environment** and is not
   declared. A user is selected by the per-binding prefix *and* its environment tag; a user with the
   prefix but no tag, or another environment's tag, is never a candidate, and neither is any
   first-class role. On Postgres, the lockout transaction runs `ALTER ROLE … NOLOGIN` and commits, then
   `pg_terminate_backend` ends the user's sessions (§3). After the declared users are provisioned, the
   sweep handles each user in a transaction of its own: it hands the user's objects to a holder role
   (below), runs `DROP OWNED BY …` (which then drops privileges only) and `DROP ROLE`. If the drop
   fails, the user stays `NOLOGIN`, the result carries `revocation-pending:<user>`, and the next run
   retries. Nothing else in the run is affected. On MySQL it runs `DROP USER`.

**Data is retained, and comes back whole.** On Postgres, `REASSIGN OWNED BY "alethia_byo_<h>" TO
"alethia_byo_<h>_r"` moves everything the user owned — its schema and every table, sequence, view,
function and type in it — to a holder role created for that user alone: `NOLOGIN`, no privileges,
tagged with the environment, readable by no chart. Because the holder owns nothing else, re-adoption is
exactly scoped: when the binding is declared again, `REASSIGN OWNED BY "alethia_byo_<h>_r" TO
"alethia_byo_<h>"` gives every one of those objects back, and the holder is dropped. Handing the
objects to the administrator would not do this — `REASSIGN OWNED BY <admin>` is not scoped to one schema,
and `ALTER SCHEMA … OWNER` re-owns the schema but not what is in it. A holder role is never selected by
the revocation sweep. On MySQL there is no ownership to move: the database stays, the re-created user
has the same name and gets the same grants back, so its views and routines (defined by that name)
work again. Removing the data needs an explicit action, which this ADR does not add.

The revocation sweep is a declared-set prune with the ExternalSecret prune's two guards: it runs only
when the declared set is known (a Job that cannot read its user list revokes nothing), and it selects
only users this environment created.

### 6. Rotation

The store is the source of truth, and the Job sets each user's password to the stored value on every
run. A rotation is therefore a change to the stored secret, through its keeper or the store's own
rotation, followed by a deploy:

- tofu writes the new password;
- the Job's `ALTER ROLE … PASSWORD '<verifier>'` / `ALTER USER … IDENTIFIED WITH … AS '<hash>'` makes it
  the user's password;
- ESO refreshes the binding Secret within its `refreshInterval` (1h), or at once on a re-apply.

Between the Job's `ALTER` and the chart's pods reading the new Secret, new connections made with the
old password fail; existing connections are unaffected. A chart that reads the password only at start
needs a restart, as with any rotated Secret. A two-user (A/B) rotation would remove that window, at the
cost of a second user and a second key per binding. It is not part of this design.

### 7. First-class services

They keep the administrative credential in password mode. The same mechanism would fit them: a
service is a binding with the same identity, and the namer and Job do not depend on the BYO marker.
Moving them is a separate change, because their tables are owned by the administrator today and
moving them means reassigning ownership of existing data.

## Slices

| # | Slice | Files | Notes |
|---|---|---|---|
| 1 | This ADR; the namer; the per-binding resolver and renderer; the `db-user` source label and the prune rule; the dark flag `ALETHIA_BYO_DB_USERS_ENABLED` | `docs/adr/byo-binding-db-users.md`, `packages/core/manifests/chart_bindings*.go`, `packages/core/argocd/binding_secrets*.go`, `packages/core/provisioner/byo_charts*.go` | **landed with this document.** With the flag on, every BYO database credential facet is unsatisfied (no user is provisioned yet) and the binding prune withdraws every BYO database binding ExternalSecret that reads the administrative credential (on a deploy where the prune runs: any binding failure skips it). Off by default. |
| 2 (#6464) | The store half: the declared set → `custom_secrets` entries on AWS, GCP and Azure; the reserved prefix; an Azure `custom_secret_names` output | `packages/core/cloud/{aws,gcp,azure}_provider*.go`, `packages/core/cloud/byo_db_users*.go`, `infra/templates/project/azure/outputs.tf` | creates secrets nothing reads until slice 4 |
| 3 (#6465) | The SQL half: `alethia db-bootstrap --byo-users` for Postgres (create with a SCRAM verifier, tag, scope, re-adopt, rotate, env-scoped revoke, the Postgres 15 floor) | `apps/runner/internal/agent/db_bootstrap_byo*.go` | pure, golden-tested |
| 4 (#6466) | The Job half: render and run the BYO users Job per cloud in its own namespace with one Secret per user, read its result, feed `DBUsers.Provisioned`, its own cleanup and sweep | `packages/core/manifests/byo_db_users*.go`, `packages/core/provisioner/byo_db_users*.go`, `packages/core/provisioner/byo_charts.go` (`provisionedByoDBUsers`) | after 2 and 3; the flag becomes usable on Postgres |
| 5 (#6467) | MySQL: a non-secret `database` facet, and the MySQL dialect of slice 3 | the facet enum, its migration and console form; `db_bootstrap_byo_mysql*.go`; `chart_bindings.go` | needs a migration |

Turning the flag on by default, and removing the administrative path for BYO bindings, follows slice
4 on Postgres and slice 5 on MySQL.

## Tests (slice 1)

`packages/core/manifests/chart_bindings_test.go` covers the namer (deterministic, distinct per
environment, namespace, workload and target, within the engines' length limits, the secret key Key
Vault-safe), and the resolver in per-binding mode: the satisfiable render, which never names the
administrative key; the unsatisfied cases (no environment ID, no user provisioned, no stored key,
`connection_string`, MySQL); and keyless still winning. `packages/core/argocd/binding_secrets_test.go` covers the prune keeping a declared
`db-user` binding only when the live object carries the label. `packages/core/provisioner/byo_charts_wiring_test.go`
covers the deploy with the flag on: nothing applied while no user is provisioned, an administrative
ExternalSecret from an earlier deploy withdrawn, a per-binding one kept, and the flag off unchanged.
