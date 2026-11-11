<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Each BYO database binding gets its own least-privilege database user

**Status:** Proposed — all five slices landed, behind a dark flag · **Issue:** #6438 ·
**Follows:** #6436 (binding ExternalSecrets, owner labels, declared-set prune, keyless parity), #6454
(the BYO marker and a namespace of its own per chart)

## Property

A bring-your-own chart's database binding receives a database user that exists for that binding alone:
it may connect to the environment's database and work inside a schema (Postgres) or database (MySQL)
of its own, and nothing else that this design grants (the limits of that are stated in §3). Its password lives in the environment's secret store under a key of its
own. The binding's ExternalSecret reads that key, and no BYO binding ever references the database's
administrative credential. Removing the binding's declaration removes its ExternalSecret and revokes
the user. The password never appears in a log, in a manifest or in SQL text sent to the server; only
its SCRAM-SHA-256 verifier (Postgres) or `caching_sha2_password` hash (MySQL) does (§3).

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

Every slice in the table below has landed (#6464, #6465, #6466, #6467), behind the dark flag
`ALETHIA_BYO_DB_USERS_ENABLED`. Turning it on by default is the step after them (see the end of the
table).

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

**MySQL** (slice 5, #6467; `apps/runner/internal/agent/db_bootstrap_byo_mysql.go`)

```sql
-- phase 0: refuse unless the server is 8.0.21 or newer (SET @f = 0 /*!80021 + 1 */, then a check)
-- phase 1: ALTER USER <every candidate> ACCOUNT LOCK
CREATE USER IF NOT EXISTS 'alethia_byo_<h>'@'%' IDENTIFIED WITH caching_sha2_password AS '<hash>'
  REQUIRE SSL WITH MAX_USER_CONNECTIONS 20 ACCOUNT LOCK ATTRIBUTE '{"alethia_env":"<environment-id>"}';
-- refuse unless the user carries this environment's tag
ALTER USER 'alethia_byo_<h>'@'%' IDENTIFIED WITH caching_sha2_password AS '<hash>' REQUIRE SSL WITH MAX_USER_CONNECTIONS 20 ACCOUNT LOCK;
CREATE DATABASE IF NOT EXISTS `alethia_byo_<h>`;
GRANT <mysqlAppPrivileges> ON `alethia\_byo\_<h>`.* TO 'alethia_byo_<h>'@'%';   -- unescaped with partial_revokes ON
-- refuse if the user holds a global privilege, GRANT OPTION, another database's privilege, or a role
ALTER USER 'alethia_byo_<h>'@'%' ACCOUNT UNLOCK;
```

MySQL has no anonymous blocks, so the script cannot branch or raise outside a stored program, and
creating a stored program would leave an object behind. Each check is therefore a prepared statement
that is either `DO 0` or a `SELECT` of a column named by the reason. That column cannot exist, so
`PREPARE` fails with *Unknown column '<reason>'* and the run stops.

**The password is sent as a `caching_sha2_password` hash, never as plaintext.** `db-bootstrap` computes
the string the server stores: `$A$005$`, a 20-character salt, and the 43-character SHA-256-crypt digest
of the password under 5000 rounds, which is the server's default and its minimum. The salt is drawn from
letters and digits, so the string needs no escaping in a literal. `IDENTIFIED WITH caching_sha2_password
AS '<hash>'` stores it unchanged. The renderer never emits `IDENTIFIED BY`, so a cloud that refused the
precomputed form would fail the run; it would not fall back to plaintext. CI verifies the form on
MySQL 8.0 and 8.4 by logging in with the password. It was not verified on RDS or Aurora, Cloud SQL or
Azure Database for MySQL. **Limitation:** as with the Postgres verifier, the hash is in the SQL text. A
server that logs statements (the general log, or an audit plugin) records it, and the client's error
output can carry it into the Job's log. The hash does not authenticate. It does allow an offline guess,
which is not practical against 32 random alphanumeric characters, but it is credential material.
Operators should not enable statement logging on a server that hosts per-binding users, or should treat
that log as sensitive.

**MySQL 8.0.21 or newer.** User `ATTRIBUTE`, and `information_schema.USER_ATTRIBUTES` that reads it,
arrived in 8.0.21, and the environment tag lives there. Without the tag no user can be revoked safely.
The script checks the server's own version with a versioned comment before it changes anything. The
runner does not run the Job when the configured version is older (5.7, or 8.0.20 and earlier). A version
without a patch, such as `8.0`, passes the runner and is held to the floor by the script.

**The environment tag is a user attribute.** MySQL has no role comments. `ATTRIBUTE '{"alethia_env":
"<id>"}'` is JSON on the account, and changing it needs the `CREATE USER` privilege, which a per-binding
user does not hold. CI measures this on 8.0 and 8.4: a provisioned user's own `ALTER USER CURRENT_USER()
ATTRIBUTE …` and `… COMMENT …` are refused and its tag is unchanged. `COMMENT` writes to the same object
under its own key, so an operator's comment does not remove the tag. A pre-existing user with a declared name and no such tag is refused, and its password,
grants and lock state are left as they were.

**Quoting.** Every identifier is backtick-quoted. Account names and values are single-quoted literals, and
a literal may not contain a backslash, so `sql_mode` cannot change its meaning, and no `"` delimits
anything. CI measures this: on 8.0 and 8.4 every real-server test runs a second time with
`NO_BACKSLASH_ESCAPES,ANSI_QUOTES` added to the global `sql_mode`. With `partial_revokes`
OFF, the default, MySQL reads `_` and `%` in a `GRANT`'s database name as wildcards. The unescaped grant
would also cover `alethiaXbyoX<h>`, and with `CREATE` the user could make such a database. The script
therefore escapes the underscores. With `partial_revokes` ON the server reads them literally, so the
script does not escape them.

**Two scripts, because MySQL account statements are not transactional.** Phase 2 cannot apply "for every
declared user or for none". Each statement is atomic, and the provision script runs without `--force`,
so the first error stops it before the result is written. A failed Job provisions nothing in the
runner's count, even if some users before the error now exist. Every statement is idempotent, so the
next run converges. Every run locks each declared user again when it sets its password, new or not,
and unlocks it only after every check on it has passed. A user refused by any check, including one an
earlier run unlocked, is therefore left locked. The cost is a moment on every run, between that `ALTER
USER` and the unlock, in which the user's new connections are refused; open ones are unaffected. The
lock also has a failure-mode cost. A run that stops between that `ALTER USER` and the unlock leaves a
declared, healthy user refusing new connections until the next successful run unlocks it. A lost
connection, the pod's deadline, or a transient error in the user's `GRANT` or in a check can each stop
it there. The Job retries (`backoffLimit: 2`); if every attempt fails, the user stays locked until a
later deploy's run succeeds, which unlocks it because every statement is idempotent. Open sessions are
unaffected throughout. The
candidates match the anchored pattern and have exactly the per-binding length. ICU's `$` also matches
before a final newline, so the length bound is what keeps a lookalike named `<user>\n` out. The sweep is a second
script, applied with `--force`, so a candidate that cannot be dropped does not stop the others. It ends
each candidate's sessions and drops each candidate, and the database is kept. MySQL has no loop outside a
stored program, so each step is rendered: 64 session kills and 32 drops per run. A candidate past the
bound stays locked, is reported as pending, and is dropped by a later run. Under `--force` a failed
statement leaves its variables as they were, so no `KILL` or `DROP USER` is ever built from a variable.
The same `SELECT … INTO` reads each target from the candidates query and builds the statement that acts
on it, after the statement was reset to `DO 0`. A step that fails therefore runs `DO 0`, and no account
outside the candidates can be named. CI tests this with the anonymous account `''@'%'` present. The result has the Postgres
form, a header line and then one line per entry. It is the only statement in either script that returns
rows. The Job sends the provision script's output to the termination message. The sweep's output
replaces it only when it starts with the header; any other output fails the container.

**Dropping a user that owns objects.** A MySQL user owns no table. It can be the `DEFINER` of a view,
routine, trigger or event. Since 8.0.22, `DROP USER` refuses such a user unless the administrator holds
`SET_USER_ID`. That candidate stays locked, the client reports the error, and the result carries
`revocation-pending:<user>`. The declared users and the other candidates are unaffected. A per-binding
user cannot create such an object itself, because the privilege set has no `CREATE VIEW`, `CREATE
ROUTINE`, `TRIGGER` or `EVENT`. Only an administrator can create one with that user as `DEFINER`.

**The limits.** Ending another user's sessions needs two privileges. `PROCESS` lets the administrator
see them (without it `information_schema.PROCESSLIST` lists only its own), and `CONNECTION_ADMIN` or
`SUPER` lets it `KILL` them. Before the kills, the sweep checks whether the administrator holds both,
directly or through an enabled role; a privilege it cannot see counts as missing. Account names are
compared as binary, because information_schema's collation is case-insensitive and MySQL user names
are not. If it holds `PROCESS` but cannot kill, the result names each revoked user that had a session
open, counted in the same statement, as `sessions-not-ended:<user>`. If it lacks `PROCESS`, no other
user's session is visible, so every revoked user is named. The runner turns each of those into a
deploy warning: any session the user had open was not terminated, and the user cannot log in again. A
session opened before the revocation then keeps running until it disconnects. The user cannot open a
new one, because it is locked and then dropped.

If that record is lost, the result says so. The statement that writes it can fail under `--force`, or
the client can reconnect and lose the session's variables. A successful record always holds a
value, even an empty list, so when it is lost the result carries `doubt:sessions-unrecorded`, and the runner warns that it cannot
say whether a revoked user's session is still open. The `revocation-pending` and `sessions-not-ended`
lists are each capped at 32 lines, as the drops are. Past the cap one `doubt:<list> +<n> more` line
counts the rest, so a backlog cannot fill the termination message on its own. Every one of these
lines is an entry, and the header counts it.

Two further gaps can only be opened by an administrator. A rotation does not `DISCARD OLD PASSWORD`, so
a secondary password an administrator set survives it. The privilege check also does not read
`mysql.proxies_priv`, so a `PROXY` grant passes it. Neither can be set by the per-binding user.

A grant written while `partial_revokes` was ON is unescaped. If the server later turns it OFF, the grant
reads as a pattern, and the check accepts it. That pattern covers only this user's own name with each
`_` matching any character. No other binding's database has such a name. The privilege check reads `information_schema`
and `mysql.role_edges`, so an administrator that cannot read the grant tables fails the run. The check
does not read table-level or column-level grants. Only an administrator can create those, because the
user holds no `GRANT OPTION`. MySQL databases have no owner, so a database with the per-binding name that
already exists is used as it is. The name is derived from this environment, and this environment's runs
are its only expected producer.

Scoped to a database of its own, with the DDL and DML set the keyless lane already grants
(`mysqlAppPrivileges`), never `*.*` or `GRANT OPTION`. MySQL has no schema below a database, so the
chart must be told which database to use: the non-secret **`database` facet**. On a per-binding MySQL
user it is that user's own database, `alethia_byo_<h>`, and it is unsatisfied, with the credential facets'
reason, until the user is provisioned. In every other case it is the environment's database, read from
the output the Jobs connect with (`rds_database_name`, `cloud_sql_database`, `azure_db_name`). These cases
are the administrative path, a keyless target, and a per-binding Postgres user, which works in its own
schema of that database.

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

### 8. The admin connection verifies the server (#6521)

The BYO users Job and the keyless bootstrap Job send an administrator credential to the database, so
both verify the server's certificate first. Neither uses an encrypt-only mode. The per-cloud choice,
its documentation, and the mechanics live in `packages/core/manifests/db_tls.go`:

| Cloud | Dials | mysql | libpq | Trust anchor |
|---|---|---|---|---|
| AWS (Aurora) | cluster endpoint | `VERIFY_IDENTITY` | `verify-full` | RDS global bundle, checked in under `dbca/` |
| Azure (flexible server) | server FQDN | `VERIFY_IDENTITY` | `verify-full` | DigiCert Global Root G2, Microsoft RSA Root CA 2017, DigiCert Global Root CA, checked in |
| GCP (Cloud SQL) | private IP | `VERIFY_CA` | `verify-ca` | the instance's own server CA (`cloud_sql_server_ca_cert`); refused unless the CA mode is per-instance |

The CA set reaches the pod as a ConfigMap rendered from those files or that output, and nothing is
fetched at run time. A verification failure fails the Job with a named reason
(`DB_TLS_VERIFY_FAILED`), and nothing retries without verification. For this Job, that means a
Failed run.

Known limits, each with its signal:

- **A new AWS Region fails verification until the bundle is updated.** Its root CAs are not in the
  pinned global bundle until `scripts/db-ca-bundles.sh update` lands them. The weekly `db-ca-bundles`
  job in `ci.yml` goes red when the upstream bundle changes, which is the cue. That job runs from the
  default branch, so it is a signal only once this is on `main`. The rendered ConfigMap is held under
  a 200 KiB budget by a test, because each Region adds about 4.5 KB of roots.
- **Azure Postgres `verify-full` behind private DNS is proven by documentation, not by a run.**
  Microsoft's Postgres TLS page says `verify-full` "might not be possible" with VNet integration or
  private endpoints, depending on DNS. The Job dials the server's own FQDN, which resolves through
  the private zone by CNAME, so the name it checks is the name on the certificate. No real server has
  confirmed this yet. **An Azure keyless T2 run has to pass before the keyless flag is turned on.**
- The other per-cloud facts are also documentation-backed only: the Aurora cluster-endpoint SAN, and
  the Cloud SQL per-instance CA default. The real-server test in `ci.yml` (`db-tls-verify`) proves the
  verification mechanics against MySQL 8.4 and Postgres 16 behind a test CA, not the clouds' own
  certificates.

## Slices

| # | Slice | Files | Notes |
|---|---|---|---|
| 1 | This ADR; the namer; the per-binding resolver and renderer; the `db-user` source label and the prune rule; the dark flag `ALETHIA_BYO_DB_USERS_ENABLED` | `docs/adr/byo-binding-db-users.md`, `packages/core/manifests/chart_bindings*.go`, `packages/core/argocd/binding_secrets*.go`, `packages/core/provisioner/byo_charts*.go` | **landed with this document.** With the flag on, every BYO database credential facet is unsatisfied (no user is provisioned yet) and the binding prune withdraws every BYO database binding ExternalSecret that reads the administrative credential (on a deploy where the prune runs: any binding failure skips it). Off by default. |
| 2 (#6464) | The store half: the declared set → `custom_secrets` entries on AWS, GCP and Azure; the reserved prefix; an Azure `custom_secret_names` output | `packages/core/cloud/{aws,gcp,azure}_provider*.go`, `packages/core/cloud/byo_db_users*.go`, `infra/templates/project/azure/outputs.tf` | creates secrets nothing reads until slice 4 |
| 3 (#6465) | The SQL half: `alethia db-bootstrap --byo-users` for Postgres (create with a SCRAM verifier, tag, scope, re-adopt, rotate, env-scoped revoke, the Postgres 15 floor) | `apps/runner/internal/agent/db_bootstrap_byo*.go` | pure, golden-tested |
| 4 (#6466) | The Job half: render and run the BYO users Job per cloud in its own namespace with one Secret per user, read its result, feed `DBUsers.Provisioned`, its own cleanup and sweep | `packages/core/manifests/byo_db_users*.go`, `packages/core/provisioner/byo_db_users*.go`, `packages/core/provisioner/byo_charts.go` (`provisionedByoDBUsers`) | after 2 and 3; the flag becomes usable on Postgres |
| 5 (#6467) | MySQL: a non-secret `database` facet, and the MySQL dialect of slices 3 and 4 | the facet enum, its migration (`0172_wooden_moon_knight`) and console form; `db_bootstrap_byo_mysql*.go`; `chart_bindings.go`; `byo_db_users*.go` | the flag becomes usable on MySQL |

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
