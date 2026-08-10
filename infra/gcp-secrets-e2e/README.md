# `gcp-secrets-e2e` — project B for the cross-project keyless Secret Manager proof (#1268)

The GCP sibling of `infra/aws-secrets-e2e`. Applied **once, by hand**, in the project that owns the
secrets. It is not the shipped customer bootstrap — that is
`infra/connector/gcp/secrets-xacct/`, which stays as it is.

## Why this needed a standing identity, and AWS did not

AWS's account-B stack trusts a narrow **principal pattern** (`ArnLike` on `aws:PrincipalArn`), which
survives a cluster that is destroyed and recreated every night.

GCP has no equivalent. IAM bindings name an exact principal, and when a service account is deleted
its binding is rewritten to `deleted:serviceAccount:…?uid=` — a same-named recreation does **not**
inherit it. So a grant made against a per-run GSA is dead by the next run.

The project template already anticipates this: setting `external_secrets_service_account_email`
makes it **adopt** a standing GSA rather than create a per-run one
(`workload-identity.tf` reads it through a `data "google_service_account"`). This stack grants that
standing GSA read access to one canary secret.

It does **not** create the GSA. That belongs in project A, next to the cluster.

⚠️ The standing GSA is a long-lived identity with cross-project read — by construction, since
outliving the cluster is the entire point. `checks.tf` refuses a project-wide binding and refuses a
GSA that lives in the target project; keep the grant on the canary alone.

## Apply

```bash
cp backend.hcl.example backend.hcl        # edit
cp terraform.tfvars.example terraform.tfvars   # edit; do NOT put canary_value here
tofu init -backend-config=backend.hcl
TF_VAR_canary_value='<a real, ≥16-char value>' tofu apply
```

The canary value is supplied at apply time and never committed. Only its **sha256** leaves the
stack — that is what the e2e compares the in-cluster read against, so the value itself never enters
CI config, a log, or the proof bundle.

## The repo variables it produces

| output | repo variable |
|---|---|
| `target_project_id` | `E2E_SECRETS_XACCT_PROJECT_ID` |
| `remote_key` | `E2E_SECRETS_XACCT_REMOTE_KEY` |
| `expect_sha256` | `E2E_SECRETS_XACCT_EXPECT_SHA256` |

`granted_service_account` is not a repo variable — it is there so you can confirm it matches the
project template's `external_secrets_service_account_email`. If the two differ, the cluster reads as
a different identity and is denied.

## What the checks refuse

- **A same-project apply.** `target_project_id == cluster_project_id` is the failure that looks most
  like success: everything applies, the digest matches, and the run reports a cross-project read it
  never performed.
- **A GSA that lives in the target project** — the grant would be project-local, the same
  false positive one step further along.
- **A project-scoped binding** instead of a secret-scoped one.
- **A canary shorter than 16 characters** — a short or empty value makes the digest comparison
  satisfiable by an empty read, which is exactly the vacuous assertion the proof exists to avoid.
