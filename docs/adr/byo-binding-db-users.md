<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Each BYO database binding gets its own least-privilege database user

**Status:** Proposed — slice 1 of 5 landed with this document · **Issue:** #6438 ·
**Follows:** #6436 (binding ExternalSecrets, owner labels, declared-set prune, keyless parity), #6454
(the BYO marker and a namespace of its own per chart)

## Property

A bring-your-own chart's database binding receives a database user that exists for that binding alone:
it may connect to the environment's database and work inside a schema (Postgres) or database (MySQL)
of its own, and nothing else. Its password lives in the environment's secret store under a key of its
own. The binding's ExternalSecret reads that key, and no BYO binding ever references the database's
administrative credential. Removing the binding's declaration removes its ExternalSecret and revokes
the user.

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
  init container and applies it with `psql` or `mysql`. It has a deadline and a TTL, its admin objects
  carry `alethia.io/bootstrap-only`, and a reaper removes the ones an operation stranded (#5915, #6413).
- **The binding ExternalSecret and its prune** (#6436): one ExternalSecret per (chart namespace,
  workload, bound target), labelled with the binding marker and the environment's owner label, pruned
  against the set the configuration *declares*.

## Decision

Only what the slice table below marks **landed** exists in code. Sections 2, 3, 5 and 6 are the design
the later slices build to.

### 1. One identity per binding ExternalSecret

A per-binding user is keyed on exactly the identity the binding ExternalSecret already has: its
namespace and its `BindingSecretName`. One namer derives both halves of the user's identity, and every
slice calls it (`manifests.ByoBindingDBUser`, `manifests.ByoBindingDBSecretKey`):

- **user** `alethia_byo_<h>`, and on Postgres a schema with the same name;
- **secret key** `alethia-byo-db-<h>` — the `custom_secrets` entry's key. Dashes only, because Azure
  Key Vault names allow no underscore;

where `<h>` is the first 12 hex characters of SHA-256 over `namespace NUL BindingSecretName`. The user
is 24 characters, inside MySQL's 32-character limit and Postgres's 63. 48 bits makes a collision
between the bindings of one environment negligible, and the prefix keeps every per-binding user
apart from the platform's own roles (`alethia_app` and the administrators), which is what lets the
revocation sweep below select by prefix.

A chart moved to another namespace (#6446) is therefore a new binding with a new user. The old user is
revoked like any removed binding, and its data stays where it was (see revocation).

### 2. The password is generated by tofu, in the store, never by the runner

The runner appends one `custom_secrets` entry per declared database binding: key
`ByoBindingDBSecretKey`, length 32, no special characters, and a keeper naming the user. Tofu then creates
the secret through the module every project secret already uses. The runner never holds the password,
never writes to a cloud API, and needs no new cloud permission. The declared set is computed from the
configuration alone, as the ExternalSecret keep set is, so a deploy that fails half way cannot delete a
live binding's secret.

The prefix `alethia-byo-db-` is reserved: a project secret named with it is refused, so the two
producers can never write one key.

### 3. The user is created by a bootstrap Job, from the stored password

A second renderer next to `RenderBootstrapJob` renders a **BYO users Job** per database: the same
admin connection per cloud, the same deadline, TTL, security context and `bootstrap-only` labels, plus
one ephemeral ExternalSecret that materialises every declared user's password from the store into the
Job's namespace. The SQL is rendered by `alethia db-bootstrap --byo-users`, from a list of users passed
as arguments and passwords read from the environment, and applied with the existing client containers.
The passwords are alphanumeric by construction (tofu generates them so), and the renderer refuses any
other character, so quoting is not a question.

The runner applies this Job itself, as it applies the binding ExternalSecrets, because the hardened BYO
project cannot carry it. It waits for completion, then deletes the Job's admin and password
ExternalSecrets on either outcome; a run interrupted before that leaves objects the reaper selects by
the `bootstrap-only` label. **A binding is satisfiable only when the Job reported its user created or
confirmed on this deploy** (`ChartBindingPolicy.DBUsers.Provisioned`). The chart is therefore never
pointed at a user that does not exist yet.

What the SQL does for each declared user, every run, idempotently:

**Postgres**

```sql
-- create if absent, else update
CREATE ROLE alethia_byo_<h> LOGIN PASSWORD '<pw>' CONNECTION LIMIT 20;   -- or ALTER ROLE … PASSWORD
GRANT alethia_byo_<h> TO CURRENT_USER;          -- RDS/Cloud SQL admins are not superusers; needed for REASSIGN below
GRANT CONNECT ON DATABASE <db> TO alethia_byo_<h>;
CREATE SCHEMA IF NOT EXISTS alethia_byo_<h> AUTHORIZATION alethia_byo_<h>;
ALTER SCHEMA alethia_byo_<h> OWNER TO alethia_byo_<h>;   -- re-adopts a schema a revoked user left
ALTER ROLE alethia_byo_<h> IN DATABASE <db> SET search_path = alethia_byo_<h>;
```

No `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`, no membership in any role, no grant on
schema `public` or on any other schema. Postgres 15+ (every managed engine offered) already denies
`CREATE` on `public` to `PUBLIC`. What `PUBLIC` keeps by default — `CONNECT` and `TEMP` on databases,
`USAGE` on `public` — is unchanged, because revoking it from `PUBLIC` would change what the first-class
services may do. It grants no access to any table.

**MySQL**

```sql
CREATE USER IF NOT EXISTS 'alethia_byo_<h>'@'%' IDENTIFIED BY '<pw>' REQUIRE SSL WITH MAX_USER_CONNECTIONS 20;
ALTER USER 'alethia_byo_<h>'@'%' IDENTIFIED BY '<pw>';
CREATE DATABASE IF NOT EXISTS `alethia_byo_<h>`;
GRANT <mysqlAppPrivileges> ON `alethia_byo_<h>`.* TO 'alethia_byo_<h>'@'%';
```

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
3. **the BYO users Job** revokes every user whose name has the `alethia_byo_` prefix and is not
   declared: on Postgres `ALTER ROLE … NOLOGIN`, `pg_terminate_backend` of its sessions,
   `REASSIGN OWNED BY … TO CURRENT_USER`, `DROP OWNED BY …` (which then drops privileges only) and
   `DROP ROLE`; on MySQL `DROP USER`.

**Data is retained.** The schema (or MySQL database) stays, owned by the administrator and readable by
no chart, so removing a binding by mistake loses nothing. If the same binding is declared again, its
user is re-created and the schema re-adopted by step 3's `ALTER SCHEMA … OWNER`. Removing the data
needs an explicit action, which this ADR does not add.

The revocation sweep is a declared-set prune with the ExternalSecret prune's two guards: it runs only
when the declared set is known (a Job that cannot read its user list revokes nothing), and it selects
only the per-binding prefix, so a first-class role is never a candidate.

### 6. Rotation

The store is the source of truth, and the Job sets each user's password to the stored value on every
run. A rotation is therefore a change to the stored secret, through its keeper or the store's own
rotation, followed by a deploy:

- tofu writes the new password;
- the Job's `ALTER ROLE … PASSWORD` / `ALTER USER … IDENTIFIED BY` makes it the user's password;
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
| 3 (#6465) | The SQL half: `alethia db-bootstrap --byo-users` for Postgres (create, scope, rotate, revoke) | `apps/runner/internal/agent/db_bootstrap_byo*.go` | pure, golden-tested |
| 4 (#6466) | The Job half: render and run the BYO users Job per cloud, feed `DBUsers.Provisioned`, clean up | `packages/core/manifests/byo_db_users*.go`, `packages/core/provisioner/byo_db_users*.go`, `packages/core/provisioner/byo_charts.go` (`provisionedByoDBUsers`) | after 2 and 3; the flag becomes usable on Postgres |
| 5 (#6467) | MySQL: a non-secret `database` facet, and the MySQL dialect of slice 3 | the facet enum, its migration and console form; `db_bootstrap_byo_mysql*.go`; `chart_bindings.go` | needs a migration |

Turning the flag on by default, and removing the administrative path for BYO bindings, follows slice
4 on Postgres and slice 5 on MySQL.

## Tests (slice 1)

`packages/core/manifests/chart_bindings_test.go` covers the namer (deterministic, distinct per
namespace and per target, within the engines' length limits, the secret key Key Vault-safe), and the
resolver in per-binding mode: the satisfiable render, which never names the administrative key; the
unsatisfied cases (no user provisioned, no stored key, `connection_string`, MySQL); and keyless still
winning. `packages/core/argocd/binding_secrets_test.go` covers the prune keeping a declared
`db-user` binding only when the live object carries the label. `packages/core/provisioner/byo_charts_wiring_test.go`
covers the deploy with the flag on: nothing applied while no user is provisioned, an administrative
ExternalSecret from an earlier deploy withdrawn, a per-binding one kept, and the flag off unchanged.
