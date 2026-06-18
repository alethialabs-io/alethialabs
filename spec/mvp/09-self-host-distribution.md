# 09 — Self-Host Distribution

**Status:** Accepted (roadmap). Easy, multi-cloud self-hosting is the open-core growth engine —
the more frictionless it is to run, the wider the top of the funnel.

## Principle

**Every distribution tier wraps the one `docker-compose` bundle — no divergent stacks.** The bundle
(`docker-compose.yml` + `deploy/prod/` overlay) is the source of truth: console · docs · postgres ·
seaweedfs · runner · caddy. Each tier below is just a different way to get that bundle onto a host.

## Tiers (effort-ordered; how big OSS ships)

### Tier 0 — Compose + one-command installer + docs ✅ (this phase)
- `deploy/install.sh` — `curl … | sh`: ensures Docker, clones to `/opt/alethia`, generates secrets,
  brings up the bundle from **public GHCR images** (no on-box build). `DOMAIN`/`ACME_EMAIL` →
  automatic TLS via Caddy; empty → HTTP `:80`. Idempotent (re-run = upgrade).
- Docs: `apps/docs/content/docs/self-hosting/` (overview, configuration, terraform, upgrading).
- Cloud-agnostic — covers all five clouds at once (it's "just a VM").

### Tier 1 — Per-cloud Terraform (`infra/<cloud>-cp`)
Thin "VM + shared cloud-init + DNS" modules; each runs the same bundle. plan-on-PR / apply-on-main
workflow per cloud. **Order: Hetzner ✅ · AWS ✅ → GCP → Azure → Alibaba.**

### Tier 2 — Helm chart (`deploy/helm/alethia`)
One chart for any managed Kubernetes (EKS/GKE/AKS/ACK/k3s): app/docs/runner Deployments, Postgres +
object storage (bundled or external), Ingress. The cloud-agnostic scale/HA path.

### Tier 3 — One-click buttons
README/docs buttons: "Deploy to Azure" (ARM), AWS "Launch Stack" (CloudFormation), DigitalOcean
1-Click. Lowest friction for users, highest per-platform upkeep → last.

## Naming / layout
- `infra/<cloud>-cp/` — control-plane host modules (the self-host Terraform).
- `infra/<cloud>-runners/` — runner-fleet modules (see [08-runner-fleet-autoscaling](08-runner-fleet-autoscaling.md)).
- `deploy/` — the shared compose bundle, prod overlay, Caddy, installer, Helm chart.

## Sequencing
1. Tier 0 (done). 2. GCP → Azure → Alibaba Terraform. 3. Helm. 4. One-click buttons.
Each ships independently; all keep using the single bundle.
