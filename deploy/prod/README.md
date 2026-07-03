# alethialabs.io production deploy — IaC + continuous deploy

The whole platform runs as one `docker compose` bundle (console · marketing · docs ·
blog · postgres · s3/SeaweedFS · runner) behind Caddy on a **single VM**, provisioned
by OpenTofu and deployed by a GitHub Action. Hosted alethialabs.io fronts that box with
a **Cloudflare Tunnel** (no public 80/443 — cloudflared dials out). The runner **fleet**
is separate: ephemeral Hetzner Cloud VMs sized by the in-app scaler.

Host-agnostic — the same compose + SSH deploy runs on **Hetzner** (`infra/cp-hetzner`,
≈€11–18/mo) or **AWS EC2** (`infra/cp-aws`). Pick one; both target the same `DEPLOY_HOST`.

## Pieces
- **`infra/cp-hetzner/`** / **`infra/cp-aws/`** — OpenTofu for the VM + firewall + cloud-init
  (installs Docker, clones the repo). `cp-hetzner` also creates the **Cloudflare Tunnel**
  (+ proxied CNAMEs) and outputs `tunnel_token`. Apply **one**.
- **`.github/workflows/infra-cp-hetzner.yml`** / **`infra-cp-aws.yml`** — plan-on-PR /
  apply-on-`main`.
- **`.github/workflows/deploy-console.yml`** — on `main`/manual: builds `console`,
  `console-migrate`, `docs`, `blog`, `marketing`, `runner` + per-cloud `runner-{aws,gcp,azure}`
  (arm64) → **public GHCR**, then SSHes to `DEPLOY_HOST` and `compose pull && up -d` with
  `docker-compose.yml` + `deploy/prod/docker-compose.prod.yml` + `deploy/prod/docker-compose.tunnel.yml`.
- **`deploy/prod/`** — `docker-compose.prod.yml` (GHCR images), `docker-compose.tunnel.yml`
  (**Cloudflare Tunnel + plain-HTTP Caddy + marketing on**), `Caddyfile` (direct-TLS path),
  `Caddyfile.tunnel` (behind-tunnel path), `.env.production.example` (the ASM vault-key
  catalog), `secrets.local.env.example` (the externals you fill in once).

## Topology (hosted, behind the tunnel)

```
Cloudflare edge (TLS, DDoS, WAF)
  │  proxied CNAME  alethialabs.io → <tunnel-id>.cfargotunnel.com
  ▼
cloudflared (compose service, OUTBOUND only — box firewall allows SSH only)
  │  http://caddy:80
  ▼
caddy  ──►  console (catch-all) · marketing (root paths) · /docs · /blog
             └► postgres + seaweedfs (internal only, on the data volume)
```

The two prod overlays compose left-to-right; the tunnel overlay adds `cloudflared`,
swaps Caddy to `Caddyfile.tunnel` (no ACME), and turns the marketing zone on. Omit it
for a direct-TLS box (Caddy gets Let's Encrypt for `ALETHIA_DOMAIN` on open 80/443).

## Auth model — least-privilege, no static keys, no GitHub secrets
All CI→cloud auth is **GitHub OIDC** (per-workflow deployer roles in
[`infra/aws-oidc`](../../infra/aws-oidc/)); there are **no** static AWS keys and **no
GitHub Actions secrets** (only non-secret *variables* = role ARNs + `PUBLIC_APP_URL`).
Every real secret lives in **one AWS Secrets Manager secret `alethia/prod/env`**; CI
reads it via OIDC and the box never holds AWS creds. TF state is AWS-native S3 (the
assumed role authenticates it). See `.env.production.example` for the vault-key catalog
(`[auto] / [chain] / [ext] / [const]`) and `secrets.local.env.example` for the externals.

**Root of trust — done once, LOCALLY (the only manual bits):**
| What | Why / how |
|---|---|
| **Transfer repo → `alethialabs-io/alethialabs`** | do this FIRST (OIDC trust + rulesets are owner/repo-scoped) |
| **AWS admin creds (local)** | to apply `infra/aws-oidc` + populate the vault (you already have these) |
| **Externals into the vault** | fill `deploy/prod/secrets.local.env` (see the example) — scoped Cloudflare token (DNS:Edit + Tunnel:Edit), two Hetzner project tokens, the deploy SSH keypair, optional OAuth/Stripe/SES |
| **GHCR packages → public** (one UI toggle, no REST API) | `console`/`console-migrate`/`docs`/`blog`/`marketing`/`runner` + `runner-{aws,gcp,azure}` — one-time, persists across re-pushes |

Everything else is generated / chained / applied automatically. **No GitHub App.**

## Go live (your triggers)
1. **Transfer** the repo to `alethialabs-io/alethialabs`; flip GHCR packages public.
2. **Bootstrap locally** (admin), once:
   ```bash
   # a) deployer roles + the ASM vault container
   cd infra/aws-oidc && cp backend.hcl.example backend.hcl && tofu init -backend-config=backend.hcl && tofu apply && cd -
   # b) dev branch + rulesets + role-ARN Actions variables (your own gh token)
   cd infra/github && cp backend.hcl.example backend.hcl && tofu init -backend-config=backend.hcl && \
     tofu apply -var "github_token=$(gh auth token)" \
       -var "cp_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw cp_deployer_role_arn)" \
       -var "runner_release_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw runner_release_deployer_role_arn)" \
       -var "deploy_reader_role_arn=$(cd ../aws-oidc && tofu output -raw deploy_reader_role_arn)" && cd -
   # c) generate internal secrets (incl. the deploy SSH keypair) + merge your externals
   cp deploy/prod/secrets.local.env.example deploy/prod/secrets.local.env   # fill EXTERNALS only
   ./scripts/bootstrap-secrets.sh
   ```
3. **Provision + deploy** (steady state): merge `staging → main`. `infra-cp-hetzner`
   applies via OIDC and **writes `DEPLOY_HOST` + `TUNNEL_TOKEN` into the vault**;
   `deploy-console` reads the vault, assembles `.env`, and brings the stack up behind the
   tunnel. No secret is ever hand-edited. (First launch: let `infra-cp-hetzner` finish
   before `deploy-console` — re-run the deploy if it races the very first provision.)

> **Re-bootstrap (destroy → back up):** everything generatable — auth secrets, DB
> passwords, storage creds, the **deploy SSH keypair** — is minted by
> `bootstrap-secrets.sh` **only-if-absent** and lives in the `alethia/prod/env` vault.
> If the vault/box is destroyed or you move clouds: `tofu apply` the two modules + one
> `./scripts/bootstrap-secrets.sh` (re-supplying only the third-party externals in
> `secrets.local.env`) → back up. Nothing generatable is ever typed.

## Runner fleet (managed autoscaling)
1. Fleet env is assembled by `deploy-console` from the vault keys `HCLOUD_FLEET_TOKEN`
   ([ext]) + `HCLOUD_SSH_KEYS` ([ext]); `FLEET_PROVIDER=hcloud` and
   `ALETHIA_RUNNER_BOOTSTRAP_TOKEN` ([auto]) are already wired — nothing to hand-edit.
2. Seed **`fleet_pools`** (one row per cloud) in Settings → Runners or via SQL. Suggested
   launch sizing (scale-to-near-zero, pre-revenue):

   | pool | warm_min | max | slots | locations | channel |
   |---|---|---|---|---|---|
   | aws | 0 | 3 | 1 | fsn1, nbg1 | stable |
   | gcp | 0 | 2 | 1 | fsn1 | stable |
   | azure | 0 | 2 | 1 | fsn1 | stable |

   `warm_min=0` = no idle cost; the first job cold-starts a VM (~25s boot + bootstrap).
   Bump to 1 per active cloud for instant pickup.
3. **Versioning is automatic:** release-please bumps the runner → `release-runner.yml`
   builds the per-cloud images + inserts a row into `runner_releases`. Pools on
   `channel: stable` resolve the latest release each 60s tick and roll out via **immutable
   drain-replace** (surge a replacement, drain the outdated VM, never drop below `warm_min`).

## Branch protection & repo governance
The `dev` branch, the `main`/`staging` **rulesets**, and the deployer-role Actions
variables are **codified in [`infra/github/`](../../infra/github/)** (Terraform `github`
provider), applied **once locally** with your own `gh` token during bootstrap (step 2b
above) — not by hand-clicking. `main` is CI-gated with **0 required approvals** (solo
repo — you can't approve your own PR); required checks are the `ci.yml` job names
(`TypeScript …`, `Integration …`, `Go …`, `Authz / open-core guards`,
`Secret scan (gitleaks)`). `owner`/`repo` are variables (default the org), so the target
is a var change.

Manual fallback (only if not using `infra/github`), against your `<owner>/<repo>`:

```bash
git push origin staging:dev
gh api -X POST repos/<owner>/<repo>/rulesets --input - <<'JSON'
{ "name": "protect-main", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" }, { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ {"context": "TypeScript (lint · types · test · docs)"},
          {"context": "Integration (real Postgres + RLS)"}, {"context": "Go (build · vet · test · lint)"},
          {"context": "Authz / open-core guards"}, {"context": "Secret scan (gitleaks)"} ] } }
  ] }
JSON
```

## staging.alethialabs.io (designed, NOT built)
Switch-on-when-funded target — do not provision yet:
- **Second compose project** (same box or a second cheap CAX box) at hostname
  `staging.alethialabs.io`, its **own** Postgres + SeaweedFS (never share prod data),
  behind the **same tunnel** (add an ingress rule → `caddy-staging:80`).
- Env deltas: `NEXT_PUBLIC_APP_URL`/`BETTER_AUTH_URL`/`NEXT_PUBLIC_SITE_URL`/
  `NEXT_PUBLIC_LEGAL_URL` = `https://staging.alethialabs.io`, a distinct
  `BETTER_AUTH_SECRET`, and `FLEET_PROVIDER=manual` (no fleet spend on staging).
- **Deploy trigger:** `workflow_dispatch` on the `staging` branch (manual, on-demand — no
  always-on cost). Add a `staging` GitHub environment + `STAGING_DEPLOY_HOST` /
  `STAGING_DOTENV` secrets when it's built.
- OAuth works on the stable subdomain (add `…/staging.alethialabs.io/api/auth/callback/*`
  redirect URIs); email-OTP works regardless.

## Cost
- **Hetzner CAX21 (default) ≈ €11/mo** — 4 vCPU/8 GB + 25 GB volume + backups; 20 TB
  egress incl. (CAX31 ≈ €18 when busy.) The bundled runner is in the box — no separate cost.
- **Fleet ≈ €0 idle** (`warm_min=0`) + hourly Hetzner VM cost only while jobs run.
- **Cloudflare Tunnel is free.** Status page (`deploy/status/`) is a separate tiny box.
- **AWS t4g.medium ≈ $36/mo** alternative (`infra/cp-aws`) — ~3× the always-on box; Hetzner
  chosen for the MVP.
