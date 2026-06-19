# Migrating an existing Supabase install off Supabase Storage

> **Fresh self-hosters do not need this doc.** Setup is codified: `cp .env.example .env && docker compose up -d` brings up SeaweedFS, and the console/runner **auto-create their buckets on first use** (`plan-artifacts`, `spec-terraform-state`) — no manual `aws s3 mb`, no hand-set env. See the repo-root `docker-compose.yml` and `.env.example`.

This note covers the **one-time data migration** for an *already-running* Supabase-hosted instance, plus storage items still pointing at Supabase that are deferred to later phases.

## 1. One-time state migration (do BEFORE cutover)

Terraform/OpenTofu state in `spec-terraform-state` is the only **un-regenerable**
data — plan artifacts are ephemeral and regenerate on the next plan. Sync it from
the old Supabase Storage endpoint to the new S3 endpoint:

```bash
aws --endpoint-url "$SUPABASE_S3_ENDPOINT" s3 sync s3://spec-terraform-state ./vts-backup
aws --endpoint-url "$ALETHIA_STORAGE_ENDPOINT"      s3 sync ./vts-backup s3://spec-terraform-state
```

Keep the Supabase bucket warm until the acid test passes: `tofu init` + `tofu plan`
against the migrated state produces **no spurious diff**.

## 2. Done in code (Supabase fully removed)

- **Scaler Lambda** no longer touches Supabase. It now POSTs each node's
  `${alethia_url}/api/platform/queue` (Bearer `RELEASE_API_SECRET`), which runs
  `recover_stale_jobs()` and returns the QUEUED count. The `supabase_url` /
  `supabase_service_role_key` variables are gone; the module takes `alethia_api_secret`
  and a per-runner `alethia_url`.
- **Helm `runner` chart** `SUPABASE_URL` / `SUPABASE_KEY` and the `portal`
  `NEXT_PUBLIC_SUPABASE_*` env are removed (the runner binary never read them).
- **AWS Secrets Manager** resource labels (`aws_secretsmanager_secret.supabase_storage_*`,
  `name = "…-supabase-s3-…"`) are **intentionally kept**: they already hold the
  `ALETHIA_STORAGE_*` values (`secret_string = var.storage_access_key_id` / `…secret_access_key`).
  The AWS secret name is immutable within its recovery window, so renaming forces
  replacement of a live secret — a cosmetic rename deferred indefinitely.

## 3. Platform TF-state backend cutover (operator step — one time)

The platform's *own* state lives at `platform/terraform.tfstate`. The CI workflow and
`backend.hcl.example` now use the `ALETHIA_STORAGE_*` endpoint; the live state object
still sits in Supabase storage until you migrate it:

```bash
cd infra/platform
# 1. Sync the platform state object Supabase → new S3.
aws --endpoint-url "$SUPABASE_S3_ENDPOINT"     s3 cp s3://terraform-state/platform/terraform.tfstate ./platform.tfstate
aws --endpoint-url "$ALETHIA_STORAGE_ENDPOINT" s3 cp ./platform.tfstate s3://terraform-state/platform/terraform.tfstate

# 2. Point backend.hcl at the new endpoint (copy from backend.hcl.example), then:
terraform init -reconfigure -migrate-state -backend-config=backend.hcl
terraform plan   # acid test: no spurious diff
```

Keep the Supabase bucket warm until the plan is clean.

## 4. GitHub repo secrets

CI reads `ALETHIA_STORAGE_ACCESS_KEY_ID`, `ALETHIA_STORAGE_SECRET_ACCESS_KEY`,
`ALETHIA_STORAGE_ENDPOINT`, `ALETHIA_STORAGE_REGION` for **both** spec state and the
platform-state backend, and `RELEASE_API_SECRET` for the scaler. After the §3 cutover,
delete the now-unused `SUPABASE_STORAGE_*`, `NEXT_PUBLIC_SUPABASE_URL`, and
`SERVICE_ROLE_SECRET` repo secrets. Also drop the stale `supabase_*` lines from your
local (untracked) `infra/platform/terraform.tfvars` — the variables no longer exist.
