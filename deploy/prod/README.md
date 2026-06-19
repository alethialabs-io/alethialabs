# alethialabs.io production deploy — IaC + continuous deploy

The whole platform runs as one `docker compose` bundle (console · docs · postgres ·
s3/SeaweedFS · runner) behind Caddy on a **single VM**, provisioned by Terraform and
deployed by a GitHub Action. **Host-agnostic** — the same compose + SSH deploy runs on
**Hetzner** (`infra/hetzner`, ~€11–18/mo) or **AWS EC2** (`infra/aws-cp`, ~$0 on lab
credits). Pick one; both target the same `DEPLOY_HOST`.

## Pieces
- **`infra/hetzner/`** / **`infra/aws-cp/`** — Terraform for the VM + firewall/SG + DNS
  (Cloudflare) + cloud-init (installs Docker, clones the repo). Apply **one**.
- **`.github/workflows/terraform-hetzner.yml`** / **`terraform-aws-cp.yml`** — plan-on-PR /
  apply-on-`main`.
- **`.github/workflows/deploy-app.yml`** — on `main`/manual: builds `console`, `console-migrate`,
  `docs`, `runner` (arm64) → **public GHCR**, then SSHes to `DEPLOY_HOST` and
  `compose pull && up -d` using `docker-compose.yml` + `deploy/prod/docker-compose.prod.yml`.
- **`deploy/prod/`** — `docker-compose.prod.yml` (GHCR images via `ALETHIA_IMAGE_TAG`), `Caddyfile`
  (TLS), `.env.production.example` (= shape of the `ALETHIA_DOTENV` secret).

## GitHub secrets
| Secret | Used by | Notes |
|---|---|---|
| `DEPLOY_HOST` | deploy-app | VM IP (Terraform output `server_ipv4`) |
| `DEPLOY_SSH_PRIVATE_KEY` / `DEPLOY_SSH_PUBLIC_KEY` | deploy-app / TF | CI deploy keypair |
| `ALETHIA_DOTENV` | deploy-app | full runtime `.env` (see `.env.production.example`) |
| `TF_STATE_S3_ENDPOINT` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | both TF | state backend (S3-compatible) — distinct from the app's `ALETHIA_STORAGE_*` |
| `HCLOUD_TOKEN` | terraform-hetzner | Hetzner API |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | terraform-aws-cp | lab account (also reused by infra/platform) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` | both TF | DNS |

> **GHCR images are public** — no pull token on the box. One-time: set the
> `console`/`console-migrate`/`docs`/`runner` packages to public in GitHub (so customers can
> `docker compose up` too).

## Go live (your triggers)
1. Choose host → set its secrets → merge an `infra/<host>/**` change to `main` (apply) → put the
   output IP in `DEPLOY_HOST`.
2. Push to `main` (or run `deploy-app` manually). `migrate` runs, then `app`/`docs`/`runner` start
   behind Caddy (auto-TLS once DNS resolves).

## Cost (Infracost-checked for AWS; Hetzner is fixed list price)
- **Hetzner CAX21 (default) ≈ €10–11/mo** — 4 vCPU/8 GB + 25 GB vol + backups + IPv4; 20 TB egress incl.
  (CAX31 ≈ €18 if it gets busy.) Runner is in the bundle — no separate fleet cost.
- **AWS t4g.medium ≈ $36/mo** (Infracost $32 + ~$3.6 IPv4); t4g.large ≈ $59. Managed runner fleet
  (`infra/platform`) ≈ $2/mo idle (scale-to-zero) + ~$0.05/runner-hr ARM Fargate only while provisioning.
- → Hetzner is ~3× cheaper for the always-on box; chosen for the MVP.

## Gating / next
- Auth runs on Better Auth and data on Postgres/Drizzle — no Supabase vars needed. For an existing
  Supabase install, migrate `spec-terraform-state` with `aws s3 sync` before cutover (see
  `infra/platform/de-supabase-storage.md`).
- Multi-cloud **runner fleet** + per-provider autoscaling is designed in
  `spec/mvp/08-runner-fleet-autoscaling.md` (built incrementally).
