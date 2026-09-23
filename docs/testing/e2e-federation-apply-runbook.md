<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Making the e2e federation authoritative — the exact four commands

#2462 asks for "four applies". Planned against live state on 2026-08-25, it is **two applies, one
import, and one stack that is already correct**. Running four applies would be wrong: on Azure it
would collide, and on AWS it would diff on nothing.

> **Part two** of this file — [the E2E assertion broker trust (#4226)](#part-two--the-e2e-assertion-broker-trust-4226)
> — adds a second issuer to the same four stacks. It was written **before** any plan against live
> state existed, because the broker has never been deployed; its expected plan shapes are
> predictions, and it says so where they appear.

Every plan in part one was generated and read before this file was written. `guard-iac.sh` refuses
`tofu apply` from an agent session, so the applies themselves are the maintainer's — that guard is
why this file exists instead of a green checkmark.

> **`backend_override.tf`** — `infra/gcp-e2e` and `infra/alibaba-e2e` keep state in a working-tree
> `terraform.tfstate` while their real backends (`gcs`/`oss`) wait on `bootstrap/`. `tofu init
> -backend=false` enables only `validate`, so planning against live state needs a local-backend
> override. Both now have one, matching the pattern `infra/azure-e2e` already used. They are
> gitignored (`infra/.gitignore` → `**/*_override.tf`) and are **not** a state migration — see
> `docs/testing/e2e-state-migration.md` for that, which is separate work.

---

## 1 · `infra/gcp-e2e` — APPLY. This one blocks `gcp/floor`.

The live e2e service account holds `roles/browser` and **no** `roles/cloudkms.admin`. #2295 is
committed but was never applied, so a gcp floor run dies inside `secrets-encryption.tf` exactly as
#2258 describes. Verified live:

```bash
gcloud projects get-iam-policy ${GCP_E2E_PROJECT_ID} \
  --flatten="bindings[].members" \
  --filter="bindings.members:alethia-e2e-nightly@${GCP_E2E_PROJECT_ID}.iam.gserviceaccount.com" \
  --format="value(bindings.role)"     # → no cloudkms.admin
```

Plan: **4 to add, 0 to change, 1 to destroy.** The destroy is only the `roles/browser` binding,
replaced by the `alethiaE2eProjectReader` custom role. **The Cloud Billing budget is NOT touched** —
that is the risk `e2e-state-migration.md` warns about, and this plan does not carry it.

```bash
cd infra/gcp-e2e
tofu init -input=false
tofu plan -input=false \
  -var 'project_id=${GCP_E2E_PROJECT_ID}' \
  -var 'billing_account_id=012128-F87F79-AAE313' \
  -var 'e2e_github_environment=e2e-dev' \
  -out=tfplan
tofu apply tfplan
```

The `budget_alerts_are_deliverable` check warns on every plan. That is #1871 and is **expected**;
it is not damage.

## 2 · `infra/alibaba-e2e` — APPLY. This one blocks alibaba entirely.

Two changes, both committed-but-unapplied:

- `+ "kms:*"` on the provision policy (#2269)
- `oidc:sub` widens from a **scalar** to a **list** — the `environment:e2e-dev` subject (#2462)

The second is why alibaba cannot be dispatched from `dev` at all today. Verified live: the trust
currently reads `"oidc:sub": "repo:alethialabs-io/alethialabs:ref:refs/heads/main"` with no list.

Plan: **0 to add, 2 to change, 0 to destroy.**

```bash
cd infra/alibaba-e2e
tofu init -input=false
ALICLOUD_PROFILE=default tofu plan -input=false \
  -var 'github_repo=alethialabs-io/alethialabs' \
  -var 'e2e_github_branch=main' \
  -var 'e2e_github_environment=e2e-dev' \
  -out=tfplan
ALICLOUD_PROFILE=default tofu apply tfplan
```

> The alicloud provider does not read the `aliyun` CLI profile unless `ALICLOUD_PROFILE` is set —
> without it the plan fails with "no valid credential sources", which looks like a missing
> credential rather than an unset variable.

## 3 · `infra/azure-e2e` — IMPORT, not apply.

**An apply here would collide.** The federated credential `gh-oidc-env` already exists live —
hand-created, with exactly the name and subject tofu would use — but is absent from state, so the
plan says `create`:

```
$ az ad app federated-credential list --id eb0f6831-… -o tsv --query "[].[name,subject]"
gh-oidc-env   repo:alethialabs-io/alethialabs:environment:e2e-dev
gh-oidc-ref   repo:alethialabs-io/alethialabs:ref:refs/heads/main
```

Adopt it instead. **The import is now declarative**: `infra/azure-e2e/imports.tf` carries an
`import {}` block with the ID below, so the next plan shows `1 to import` for
`github["env"]` instead of `1 to add`, and the apply that follows adopts the credential rather
than colliding with it. Do **not** also run `tofu import` by hand — the block does it. After that
apply the plan should be **empty**, which is the actual goal of #2462 — state agreeing with the
account.

The ID the block uses (application OBJECT id / credential id, both read live on 2026-08-25):
`/applications/eb0f6831-ef39-4a5a-ab87-899661c36f14/federatedIdentityCredential/eae3cf58-1f19-4270-9bb1-7c46e0f94a12`

```bash
cd infra/azure-e2e
tofu init -input=false
# expect: azuread_application_federated_identity_credential.github["env"] will be imported,
# and no create for it. Then `tofu apply` with the same -var flags, and re-plan to confirm
# it is a no-op:
tofu plan -input=false \
  -var 'subscription_id=32f3d6ca-f9b5-48f1-b714-dcfb9cc661ae' \
  -var 'github_repo=alethialabs-io/alethialabs' \
  -var 'e2e_github_branch=main' \
  -var 'location=germanywestcentral' \
  -var 'e2e_monthly_budget_usd=100' \
  -var 'e2e_budget_alert_emails=["<the real list>"]' \
  -var 'e2e_github_environment=e2e-dev'
```

Azure is **not** blocked on this — it federates and provisions today. This is bookkeeping that stops
the next operator's apply from failing.

## 4 · `infra/aws-oidc` — ALREADY CORRECT. Do nothing.

State and account already agree, both subjects present:

```
$ aws iam get-role --role-name alethia-e2e-nightly \
    --query 'Role.AssumeRolePolicyDocument.Statement[].Condition'
"token.actions.githubusercontent.com:sub": [
  "repo:alethialabs-io/alethialabs:ref:refs/heads/main",
  "repo:alethialabs-io/alethialabs:environment:e2e-dev"
]
```

A plan run here shows `1 to change` **only** if you pass a different `e2e_budget_alert_emails` than
the applied one — an artifact of the variable, not drift. Pass the real list (or none) and it is
empty. There is no IAM diff.

---

## What each unblocks

| stack | action | unblocks |
|---|---|---|
| `gcp-e2e` | apply | `gcp/floor` and everything above it — currently dies at `secrets-encryption.tf` |
| `alibaba-e2e` | apply | alibaba dispatch-from-`dev` at all, plus its CMK path |
| `azure-e2e` | import (declarative, `imports.tf`) | nothing today; prevents the next apply colliding |
| `aws-oidc` | — | already authoritative |

## A trap that cost a session

A previous session symlinked its own scratchpad into the **shared** home plugin cache:

```
~/.terraform.d/plugin-cache/registry.opentofu.org/aliyun/alicloud/1.286.0/darwin_arm64
  -> /private/tmp/claude-501/…/<a deleted session id>/scratchpad/plugins/…
```

When that scratchpad was cleaned up the cache entry became a dangling symlink, and **every**
subsequent `tofu init` needing the alicloud provider failed with a `lstat … no such file or
directory` that names a path nobody recognises. The entry has been removed and re-downloaded; no
other provider was affected. Never point `plugin_cache_dir`, or anything it contains, at a
session-scoped directory.

---

## Part two — the E2E assertion broker trust (#4226)

The four e2e identities trust **one** issuer today: GitHub Actions. #4226 adds a second, the
dedicated E2E assertion broker (`apps/e2e-issuer`), so the nightly's `cli-demo` proof (#4227) can
authenticate to each cloud the way a customer's console does, with a short-lived `alethia-connector`
assertion, not a GitHub token.

**Nothing here is applied by an agent, and nothing in CI applies these stacks.** `guard-iac.sh`
refuses `tofu apply` in an agent session. No workflow applies any of these four stacks:
`infra-aws-oidc.yml` validates `aws-oidc` only, and no workflow reads the other three. Every apply
below is the maintainer's, from a plan the maintainer has read.

### What is in the tree

The trust is written and **committed, but not applied**. Every stack has a variable
`e2e_broker_issuer_url`, and every committed `terraform.tfvars` sets it to
`https://e2e-issuer.alethialabs.io` (#4226). Nothing exists in any cloud until the maintainer applies,
but a plan of the current tree **does** show the broker resources below — so an apply of any of these
stacks, for any reason, creates the trust. Do not apply them before the issuer serves (see *Before you
plan*). `null` still means off: with it nothing is created and no trust document changes.

| stack | when the issuer is set, it adds | file |
|---|---|---|
| `aws-oidc` | an IAM OIDC provider, plus an `E2EBrokerAssertion` statement in `alethia-e2e-nightly`'s trust | `e2e-broker.tf`, `e2e-nightly.tf` |
| `gcp-e2e` | its **own** workload identity pool and provider, plus one `roles/iam.workloadIdentityUser` member on the e2e SA | `e2e-broker.tf` |
| `azure-e2e` | one federated identity credential, `e2e-assertion-broker`, on the e2e application | `e2e-broker.tf` |
| `alibaba-e2e` | a RAM OIDC provider, plus a second statement in `alethia-e2e-nightly`'s trust | `e2e-broker.tf`, `roles.tf` |

What each cloud pins. The audience and subject are **read from**
`packages/workload-identity/src/broker.ts` at plan time (`WORKLOAD_PROVIDER_AUDIENCES`,
`WORKLOAD_SUBJECT`). They are not typed a second time. If that file moves or its shape changes, the
plan errors.

| | issuer | audience | subject | run binding | lifetime |
|---|---|---|---|---|---|
| AWS | provider URL | `sts.amazonaws.com` | `alethia-connector` | broker only¹ | broker only² |
| GCP | `issuer_uri` | `alethia-gcp-wif` | `alethia-connector` (one principal) | `provider == "gcp"`, `repository`, `workflow_ref ∈ e2e_broker_workflow_refs` | broker only² |
| Azure | credential issuer | `api://AzureADTokenExchange` | `alethia-connector` | broker only¹ | broker only² |
| Alibaba | `oidc:iss` | `sts.aliyuncs.com` | `alethia-connector` | broker only¹ | `issuance_limit_time = 1` h, plus the broker² |

¹ IAM, Entra and RAM read only `iss`, `aud` and `sub` from a non-GitHub issuer. The run binding
(`repository`, `workflow_ref`, `run_id`, `run_attempt`) is in the assertion, but only GCP can
condition on it. Everywhere else the **broker** enforces it before signing: `ALLOWED_REPOSITORIES`,
`ALLOWED_WORKFLOW_REFS`, the cross-check against the caller's GitHub token, and the one-use replay
guard. `run_id` and `run_attempt` change every run, so no standing trust can pin them on any cloud.

² No cloud has a setting for the incoming token's lifetime, except Alibaba's coarse one-hour floor.
All four refuse an expired token. The broker mints for 60–600 s
(`MIN_/MAX_ASSERTION_TTL_SECONDS`), so that is the effective cap.

**No private key or assertion material is in any plan.** The stacks hold the issuer's public origin,
the audiences and the subject. The signing keys are a secret on the `e2e-issuer` GitHub environment
(`apps/e2e-issuer/README.md`). The clouds fetch only the public JWKS. Alibaba's provider records the
issuer's **CA certificate fingerprints**, which are public.

### Before you plan

1. **The issuer serves at its custom domain.** The origin is `https://e2e-issuer.alethialabs.io`
   (maintainer ruling on #4226, 2026-09-23): a Workers Custom Domain that `infra/e2e-issuer` binds to
   the Worker, with `workers.dev` turned off. Steps 1–6 of the runbook in
   [`infra/e2e-issuer/README.md`](../../infra/e2e-issuer/README.md) are done: the zone-scoped token,
   the `infra/e2e-issuer` apply, `E2E_ISSUER_URL` set to that origin, a green *Deploy E2E assertion
   issuer* run, and the reviewed TLS pin (`infra/e2e-issuer/tls-ca-pin.json`) merged. The deploy's
   post-deploy step fetches discovery at `E2E_ISSUER_URL`, so a green deploy means the origin answers.
2. **The origin is already committed.** All four `terraform.tfvars` carry
   `e2e_broker_issuer_url = "https://e2e-issuer.alethialabs.io"`, the same string as
   `infra/e2e-issuer`'s `hostname`. `node scripts/ci/check-e2e-issuer-health.mjs --static` fails any PR
   that lets those copies drift. **Until step 1 is done, do not apply any of the four stacks**, for any
   reason: with the origin committed, every apply creates the broker trust.
3. **The origin answers, and the health check is green.** This must print the same origin back:
   ```bash
   curl -fsS https://e2e-issuer.alethialabs.io/.well-known/openid-configuration | jq -r .issuer
   node scripts/ci/check-e2e-issuer-health.mjs --expected-url https://e2e-issuer.alethialabs.io
   ```
   The second command exits `0` only when discovery, the JWKS, key age, the TLS pin and latency all
   pass. The *E2E issuer health* workflow runs the same check every six hours and keeps one
   `tracker:e2e-issuer-health` issue open while anything fails.
4. **`gcp-e2e`'s `e2e_broker_workflow_refs` equals the broker's `ALLOWED_WORKFLOW_REFS`.** The
   default is `alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev`, the
   value #4226 proposed for that variable. If the variable changed, change the list too.

### Enable it — one plan and apply per cloud

The origin is already in all four `terraform.tfvars` (#4226):

```hcl
e2e_broker_issuer_url = "https://e2e-issuer.alethialabs.io"
```

Keep it in the committed file, **not** `-var` at apply time. With `-var`, the next bare apply reads
the committed value and rewrites or **removes** the trust.

**Alibaba pins the reviewed TLS CA set, not the chain it sees at plan.** `alibaba-e2e` sets the RAM
OIDC provider's fingerprints from `infra/e2e-issuer/tls-ca-pin.json` (at most five, RAM's limit).
Its plan **fails** with a precondition error when that file is empty, names another origin, or does
not cover every CA certificate the host serves at plan time. The fix is never to edit the stack: run
`node scripts/ci/check-e2e-issuer-health.mjs --print-pin --expected-url https://e2e-issuer.alethialabs.io`,
review the output, commit it to `tls-ca-pin.json` in a PR, and plan again after it merges.

Then plan each stack as part one does, with the same inputs. The expected shapes below are
**predictions from the code**. Nobody has planned them against live state, because there has been no
issuer to plan against. If a plan shows anything else, stop and read it.

| stack | expected plan | a sign something is wrong |
|---|---|---|
| `aws-oidc` | `1 to add` (the OIDC provider), `1 to change` (`alethia-e2e-nightly`'s `assume_role_policy`, gaining one statement, shown in full) | any change to `GithubOIDCNightly`, any other role, or an `assume_role_policy` shown as `(known after apply)` |
| `gcp-e2e` | `3 to add` (pool, provider, SA IAM member, with the member's `principal://…` string shown in full) | any change to `alethia-e2e-gh-pool`, its provider or `e2e_wif`, or a member shown as `(known after apply)` |
| `azure-e2e` | `1 to add` (the `e2e-assertion-broker` credential) | any change to `gh-oidc-ref` or `gh-oidc-env` |
| `alibaba-e2e` | `1 to add` (the RAM OIDC provider), `1 to change` (the role's trust document, gaining a second statement, shown in full) | any change to `Statement[0]`, to the `alethia-github-e2e` provider, or a trust document shown as `(known after apply)` |

**The enabling plan shows the whole new trust document, not `(known after apply)`.** Read it. On AWS
and Alibaba the broker statement names its OIDC provider, and on GCP the SA member names its pool.
The provider ARN and the pool name are computed by the cloud when the object is created, so a trust
that read them off the resource would be unknown on exactly this plan. So each stack **builds** that
name from values it has at plan time (the account ID or project number from a data source, and the
provider name, issuer host or pool ID from a variable):

| stack | built as |
|---|---|
| `aws-oidc` | `arn:aws:iam::<account>:oidc-provider/<issuer host>` |
| `alibaba-e2e` | `acs:ram::<account>:oidc-provider/<broker_oidc_provider_name>` |
| `gcp-e2e` | `projects/<project number>/locations/global/workloadIdentityPools/<broker_pool_id>` |

`azure-e2e` needs none of this: its credential's issuer, subject and audience are all inputs.

Because the name is built, it can disagree with the object the cloud creates. A check compares the
two (`e2e_broker_provider_arn_matches` on AWS and Alibaba, `e2e_broker_pool_name_matches` on GCP).
On the enabling plan the created object's name does not exist yet, so **that one check reports at
apply**, not at plan. On every later plan it reports at plan. If it warns after the apply, the
trust names an object that does not exist: roll back (below) and report it.

The other broker checks report on the enabling plan. Every stack has three: the broker trust is
**exact**, it is **additive** (the GitHub trust is unchanged), and it is **absent** when unset.
`gcp-e2e` has a fourth, `e2e_broker_binding_is_one_subject`: the SA member is one principal, never a
principal set. So `aws-oidc` and `alibaba-e2e` have four broker checks, `gcp-e2e` five and
`azure-e2e` three. A check **warns**; it does not fail the plan. Read the warnings.

`gcp-e2e`, `azure-e2e` and `alibaba-e2e` also include `checks.tftest.hcl`. It runs against mocked
providers, so it needs no credentials, and no workflow runs it. Run it in each of those directories
before you plan:

```bash
tofu init -backend=false && tofu test
```

It checks the planned values against the literals in `broker.ts`, that the trust names the built
provider ARN or pool name rather than the created object's, and that the guards fire. These tests were
run with OpenTofu 1.12.3. CI pins 1.10.10, and the tests have never run on that version.
`aws-oidc` has no such test: its trust document comes from a data source that a mock cannot
render.

```bash
# the per-stack pattern; add the same -var inputs part one uses for that stack
tofu plan -input=false -out=tfplan
tofu show tfplan     # read it
tofu apply tfplan
```

`gcp-e2e` has one real gate. If `e2e_broker_workflow_refs` is empty or names another repository, a
`precondition` refuses the plan. Without a workflow pin, the run binding would admit any workflow in
the repository.

### Verify

```bash
aws iam get-role --role-name alethia-e2e-nightly \
  --query 'Role.AssumeRolePolicyDocument.Statement[].Sid'        # GithubOIDCNightly, E2EBrokerAssertion
gcloud iam workload-identity-pools providers describe alethia-e2e-broker-oidc \
  --workload-identity-pool=alethia-e2e-broker --location=global --project=<e2e project> \
  --format='value(attributeCondition,oidc.issuerUri)'
az ad app federated-credential list --id <e2e app id> -o tsv --query "[].[name,issuer,subject]"
aliyun ram GetRole --RoleName alethia-e2e-nightly               # AssumeRolePolicyDocument: two statements
```

The end-to-end proof is #4227's. The nightly exchanges a real broker assertion on each cloud. Until
that runs, the trust is configured but **unproven**.

### Roll back, one cloud at a time

Set that stack's `e2e_broker_issuer_url` back to `null` in `terraform.tfvars`, merge the change, then
plan and apply. The expected plan is the reverse of the table above: the broker objects are
destroyed, the AWS or Alibaba trust document loses its second statement, and nothing else changes.
Each stack is independent, so you can remove one cloud's trust and keep the others.

**GCP deletion is soft.** A destroyed pool stays recoverable for 30 days, and its ID
(`alethia-e2e-broker`) cannot be reused in that time. To enable it again within 30 days, restore the
pool first, then plan again:

```bash
gcloud iam workload-identity-pools undelete alethia-e2e-broker --location=global --project=<e2e project>
```

Alternatively, set a new `broker_pool_id`.

### Rotation

- **Signing keys: no infrastructure change.** Every cloud fetches the broker's JWKS from the
  issuer, so a key rotation happens entirely in the broker. Follow the procedure in
  `apps/e2e-issuer/README.md`: publish, wait 24 h, sign with the new key, wait 24 h, retire the old
  key. None of the four stacks pins a key.
- **Alibaba certificate fingerprints: a reviewed change, announced before it breaks.** The RAM
  provider pins the fingerprints in `infra/e2e-issuer/tls-ca-pin.json` — every CA certificate the
  issuer's host serves, at most five. Cloudflare can re-issue the host's certificate from another CA
  (its CAA injection lists four for this zone) or another intermediate, and on this zone that cannot
  be pinned to one CA — `infra/e2e-issuer/README.md` has the sources. When it happens, AssumeRoleWithOIDC
  fails for the broker only. The *E2E issuer health* workflow compares the served chain with the pin
  every six hours and opens the `tracker:e2e-issuer-health` issue naming the new certificate. To fix
  it: `node scripts/ci/check-e2e-issuer-health.mjs --print-pin --expected-url https://e2e-issuer.alethialabs.io`
  (it keeps the existing entries and appends the new ones), commit the reviewed file, then plan and
  apply `alibaba-e2e` — the plan's only change is `fingerprints` on `alethia-e2e-broker`. Remove a
  retired entry by hand, in a later PR, once the new chain is confirmed (RAM's guidance: add the new
  fingerprint at least a day before a rotation). The plan refuses, by precondition, to write a pin that
  does not cover the chain being served. The GitHub provider in `oidc.tf` still pins its chain at plan
  time and keeps the old exposure.
- **The issuer origin.** A new origin is a new issuer on every cloud. Change `hostname` in
  `infra/e2e-issuer/terraform.tfvars`, the origin in all four `terraform.tfvars` and `issuer_url` in
  `tls-ca-pin.json` in one PR (`--static` fails the PR if any copy is missed), and plan each stack. Read whether each plan updates the issuer in
  place or replaces the object. This file does not predict which, because nobody has measured it.
  Broker runs fail between the Worker moving and each apply, so do it when no nightly is scheduled.
