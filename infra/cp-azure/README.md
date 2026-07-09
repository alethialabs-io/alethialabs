<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-azure

Azure control-plane box (single x86 Gen2 Linux VM) running the Alethia control plane. One of the
per-cloud `cp-*` siblings — see [`infra/README.md`](../README.md). It ports the working
[`cp-hetzner`](../cp-hetzner) design (Cloudflare Tunnel ingress) to Azure, shaped for what's best on
Azure rather than a 1:1 clone.

- **Provider:** Azure (`hashicorp/azurerm ~> 4.0`) + Cloudflare (`~> 4.40`). **State:** S3-compatible
  `terraform-state` · key `azure-cp/terraform.tfstate` (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static service-principal via `.github/workflows/infra-cp-azure.yml`
  (`ARM_CLIENT_ID` / `ARM_CLIENT_SECRET` / `ARM_SUBSCRIPTION_ID` / `ARM_TENANT_ID` + `CLOUDFLARE_*`).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```

## Architecture — why it's shaped this way

- **Ingress: Cloudflare Tunnel, no public web ports.** `cloudflared` (a compose service on the box)
  dials **out** to Cloudflare; the NSG has **no inbound Allow rules** (Azure denies inbound by
  default). Apex + `www` are **proxied** CNAMEs onto `<tunnel_id>.cfargotunnel.com`; TLS terminates at
  Cloudflare's edge. The connector uses the remotely-managed config (`config_src = "cloudflare"`) and
  only needs `tunnel_token` (the `TUNNEL_TOKEN` env the compose `cloudflared` reads).
- **Access: no inbound at all.** Azure Bastion (~$140/mo) is out of line for a cheap box, and CI can't
  use interactive SSH anyway (dynamic runner IPs), so:
  - **Automation / deploy:** `az vm run-command invoke -g <rg> -n alethia-cp --command-id RunShellScript
    --scripts '…'` — control-plane, through the VM agent, **no open port**, authenticated by the VM's
    system-assigned managed identity.
  - **Interactive break-glass:** the **Azure Serial Console** (enabled by boot diagnostics) — a root
    TTY via the platform, no network path. (`az serial-console connect -g <rg> -n alethia-cp`.)

  This mirrors the zero-standing-inbound posture of `cp-aws` (SSM) and `cp-gcp` (IAP): $0, no open
  port. The tradeoff — interactive access is a serial TTY, not SSH (no `scp`) — is acceptable for a
  compose/CI-managed box.
- **Egress: a Standard public IP.** Azure retires default outbound (Sep 2025), so the VM needs an
  explicit egress path; a Standard public IP (~$3.6/mo) is the cheapest for one box (a NAT gateway
  would be ~$32/mo). It is **egress-only** — the NSG denies all inbound. (Unlike GCP, Trivy's Azure
  ruleset doesn't flag the egress IP at HIGH/CRITICAL, so this stack needs **no `.trivyignore`
  suppression** — it scans clean.)
- **Hardening:** **Trusted Launch** (secure boot + vTPM — Azure's Shielded-VM analog), a
  **system-assigned managed identity**, **boot diagnostics** (enables Serial Console),
  `disable_password_authentication`, and an inbound-free NSG. Managed disks are SSE-encrypted at rest
  by default. Invariants are asserted in `checks.tf`.
- **Durability:** the OS disk holds Docker's data-root (Postgres + object storage) and is
  snapshottable — no separate data volume.

## One control-plane at a time

The `cp-*` siblings all serve the **same domain/zone**. They are alternatives — apply **one instead of
another**, never two at once (two would fight over the apex DNS + tunnel). Prod currently runs on
`cp-hetzner`, so this stack's `apply` job stays **gated off** (`vars.INFRA_AZURE_APPLY != 'true'`); the
PR `plan` job still validates the Terraform.

## Not managed here — inbound email

Cloudflare **Email Routing** is zone-global (one config per domain) and is owned by whichever cp is
live (`cp-hetzner/email-routing.tf`, gated). It is intentionally **not** duplicated here to avoid
colliding on the shared zone.
