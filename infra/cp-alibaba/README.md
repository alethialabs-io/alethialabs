<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-alibaba

Alibaba Cloud control-plane box (single Yitian 710 ARM ECS instance) running the Alethia control
plane. One of the per-cloud `cp-*` siblings — see [`infra/README.md`](../README.md). It ports the
working [`cp-hetzner`](../cp-hetzner) design (Cloudflare Tunnel ingress) to Alibaba Cloud, shaped for
what's best on Alibaba rather than a 1:1 clone.

- **Provider:** Alibaba Cloud (`aliyun/alicloud ~> 1.230`) + Cloudflare (`~> 4.40`). **State:**
  S3-compatible `terraform-state` · key `alibaba-cp/terraform.tfstate` (custom endpoint — see
  `backend.hcl.example`).
- **CI auth:** static keys via `.github/workflows/infra-cp-alibaba.yml`
  (`ALICLOUD_ACCESS_KEY` / `ALICLOUD_SECRET_KEY` + `CLOUDFLARE_*`).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```

## Architecture — why it's shaped this way

- **Ingress: Cloudflare Tunnel, no public web ports.** `cloudflared` (a compose service on the box)
  dials **out** to Cloudflare; the security group has **no inbound rules**. Apex + `www` are **proxied**
  CNAMEs onto `<tunnel_id>.cfargotunnel.com`; TLS terminates at Cloudflare's edge. The connector uses
  the remotely-managed config (`config_src = "cloudflare"`) and only needs `tunnel_token` (the
  `TUNNEL_TOKEN` env the compose `cloudflared` reads).
- **Access: ECS Session Manager / Cloud Assistant — no open port.** Alibaba's Cloud Assistant agent
  (preinstalled on the official Ubuntu image) dials out, so there is **no inbound SSH**:
  - **Interactive:** ECS Session Manager (Alibaba console → ECS → the instance → *Connect*, or the CLI).
  - **Automation / deploy:** `aliyun ecs RunCommand` (Cloud Assistant) — no port.

  This mirrors the zero-standing-inbound posture of `cp-aws` (SSM) and `cp-gcp` (IAP): $0, no open
  port.
- **Egress: an auto-assigned public IP.** `internet_max_bandwidth_out` gives the box a pay-by-traffic
  public IP for outbound (image pulls, `git clone`, tunnel + Cloud Assistant dial-out). It is
  **egress-only** — the security group denies all inbound.
- **Hardening:** the **system disk is encrypted** (`system_disk_encrypted`), the security group has no
  inbound rules, and no SSH key pair is created (Session Manager needs none). Invariants are asserted
  in `checks.tf`.
- **Durability:** the `cloud_essd` system disk holds Docker's data-root (Postgres + object storage) and
  is snapshottable — no separate data volume.

## One control-plane at a time

The `cp-*` siblings all serve the **same domain/zone**. They are alternatives — apply **one instead of
another**, never two at once (two would fight over the apex DNS + tunnel). Prod currently runs on
`cp-hetzner`, so this stack's `apply` job stays **gated off** (`vars.INFRA_ALIBABA_APPLY != 'true'`);
the PR `plan` job still validates the Terraform.

## Not managed here — inbound email

Cloudflare **Email Routing** is zone-global (one config per domain) and is owned by whichever cp is
live (`cp-hetzner/email-routing.tf`, gated). It is intentionally **not** duplicated here to avoid
colliding on the shared zone.
