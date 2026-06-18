# Migrating an existing Supabase install off Supabase Storage

> **Fresh self-hosters do not need this doc.** Setup is codified: `cp .env.example .env && docker compose up -d` brings up SeaweedFS, and the console/worker **auto-create their buckets on first use** (`plan-artifacts`, `vine-terraform-state`) — no manual `aws s3 mb`, no hand-set env. See the repo-root `docker-compose.yml` and `.env.example`.

This note covers the **one-time data migration** for an *already-running* Supabase-hosted instance, plus storage items still pointing at Supabase that are deferred to later phases.

## 1. One-time state migration (do BEFORE cutover)

Terraform/OpenTofu state in `vine-terraform-state` is the only **un-regenerable**
data — plan artifacts are ephemeral and regenerate on the next plan. Sync it from
the old Supabase Storage endpoint to the new S3 endpoint:

```bash
aws --endpoint-url "$SUPABASE_S3_ENDPOINT" s3 sync s3://vine-terraform-state ./vts-backup
aws --endpoint-url "$ALETHIA_STORAGE_ENDPOINT"      s3 sync ./vts-backup s3://vine-terraform-state
```

Keep the Supabase bucket warm until the acid test passes: `tofu init` + `tofu plan`
against the migrated state produces **no spurious diff**.

## 2. Still on Supabase (deferred to later phases — not storage)

- **The platform's own TF-state backend** — `infra/platform/backend.hcl` (hardcoded
  `…storage.supabase.co…`) and the CI `-backend-config` lines in
  `.github/workflows/terraform-platform.yml` (~L52-55, L116-119). Repointing this is
  its own careful cutover (sync the *platform* state bucket, then change the endpoint).
- **Scaler Lambda** `supabase_url` / `supabase_service_role_key`, the `tendril` Helm
  chart `SUPABASE_URL` / `SUPABASE_KEY`, and `portal` `NEXT_PUBLIC_SUPABASE_*` are
  **DB/auth**, not storage — they go with Phase D/F.
- **AWS Secrets Manager** resource labels (`aws_secretsmanager_secret.supabase_storage_*`)
  and their `name = "…-supabase-s3-…"` strings are kept as-is: the AWS secret name is
  immutable within its recovery window, so renaming forces replacement. Cosmetic →
  folded into Phase F cleanup.

## 3. GitHub repo secrets

CI now reads `ALETHIA_STORAGE_ACCESS_KEY_ID`, `ALETHIA_STORAGE_SECRET_ACCESS_KEY`, `ALETHIA_STORAGE_ENDPOINT`,
`ALETHIA_STORAGE_REGION` (vine state). Add these; the old `SUPABASE_S3_*` / `SUPABASE_STORAGE_*`
secrets for vine state can be removed after cutover (the platform-state backend config
in §2 still uses the Supabase ones until that separate cutover).
