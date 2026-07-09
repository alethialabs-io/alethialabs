<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-gcp

GCP control-plane box running the Alethia control plane. One of the per-cloud `cp-*` siblings —
see [`infra/README.md`](../README.md). It ports the working [`cp-hetzner`](../cp-hetzner) design
(Cloudflare Tunnel ingress) to GCP, shaped for what's actually best on GCP rather than a 1:1 clone.

- **Provider:** GCP (`hashicorp/google ~> 6.0`) + Cloudflare (`~> 4.40`). **State:** S3-compatible
  `terraform-state` · key `gcp-cp/terraform.tfstate` (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static service-account JSON via `.github/workflows/infra-cp-gcp.yml`
  (`GOOGLE_CREDENTIALS`, `GCP_PROJECT` + `CLOUDFLARE_*`, `DEPLOY_SSH_PUBLIC_KEY`).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```

## Architecture — why it's shaped this way

- **Ingress: Cloudflare Tunnel, no public web ports.** `cloudflared` (a compose service on the box)
  dials **out** to Cloudflare; the box's firewall opens **no 80/443**. Apex + `www` are **proxied**
  CNAMEs onto `<tunnel_id>.cfargotunnel.com`; TLS terminates at Cloudflare's edge. The connector uses
  the remotely-managed config (`config_src = "cloudflare"`) and only needs `tunnel_token` (exported as
  the `TUNNEL_TOKEN` env the compose `cloudflared` reads).
- **SSH: Identity-Aware Proxy (IAP) only.** The firewall allows `tcp/22` **only** from the IAP range
  `35.235.240.0/20` — there is no world-open SSH. Connect with:
  ```bash
  gcloud compute ssh alethia-cp --zone <zone> --tunnel-through-iap
  ```
- **Egress: one ephemeral external IP.** The box needs outbound (image pulls, `git clone`, the tunnel
  dial-out); a plain ephemeral external IP is the cheapest path (~$3/mo) — a Cloud NAT gateway would be
  ~10× that for a single VM. The IP is **egress-only**: inbound web is tunnel-fronted, inbound SSH is
  IAP-gated. Trivy flags the presence of any public IP (`GCP-0031`); that one finding is a reviewed,
  documented suppression in [`infra/.trivyignore`](../.trivyignore) — it mirrors the accepted
  `cp-hetzner` posture (whose box also has a public IP).
- **Hardening:** Shielded VM (secure boot + vTPM + integrity monitoring), a **dedicated** least-priv
  service account (no project IAM roles; logging/monitoring scopes only — not the default compute SA),
  and `block-project-ssh-keys`. Invariants are asserted in `checks.tf`.
- **Durability:** the `pd-balanced` boot disk holds Docker's data-root (Postgres + object storage) and
  is snapshottable — no separate data volume (unlike the Hetzner box's attached volume).

## One control-plane at a time

The `cp-*` siblings all serve the **same domain/zone**. They are alternatives — apply **one instead of
another**, never two at once (two would fight over the apex DNS + tunnel). Prod currently runs on
`cp-hetzner`, so this stack's `apply` job stays **gated off** (`vars.INFRA_GCP_APPLY != 'true'`); the PR
`plan` job still validates the Terraform.

## Not managed here — inbound email

Cloudflare **Email Routing** is zone-global (one config per domain) and is owned by whichever cp is
live (`cp-hetzner/email-routing.tf`, gated). It is intentionally **not** duplicated here to avoid
colliding on the shared zone.
