<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Making the e2e federation authoritative — the exact four commands

#2462 asks for "four applies". Planned against live state on 2026-08-25, it is **two applies, one
import, and one stack that is already correct**. Running four applies would be wrong: on Azure it
would collide, and on AWS it would diff on nothing.

Every plan below was generated and read before this file was written. `guard-iac.sh` refuses
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
gcloud projects get-iam-policy itgix-adp \
  --flatten="bindings[].members" \
  --filter="bindings.members:alethia-e2e-nightly@itgix-adp.iam.gserviceaccount.com" \
  --format="value(bindings.role)"     # → no cloudkms.admin
```

Plan: **4 to add, 0 to change, 1 to destroy.** The destroy is only the `roles/browser` binding,
replaced by the `alethiaE2eProjectReader` custom role. **The Cloud Billing budget is NOT touched** —
that is the risk `e2e-state-migration.md` warns about, and this plan does not carry it.

```bash
cd infra/gcp-e2e
tofu init -input=false
tofu plan -input=false \
  -var 'project_id=itgix-adp' \
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

Adopt it instead. After the import the plan should be **empty**, which is the actual goal of #2462 —
state agreeing with the account.

```bash
cd infra/azure-e2e
tofu init -input=false
tofu import \
  'azuread_application_federated_identity_credential.github["env"]' \
  '/applications/eb0f6831-ef39-4a5a-ab87-899661c36f14/federatedIdentityCredential/eae3cf58-1f19-4270-9bb1-7c46e0f94a12'
# then confirm it is a no-op:
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
| `azure-e2e` | import | nothing today; prevents the next apply colliding |
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
