<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-alibaba

Alibaba Cloud control-plane box (single x86 ECS instance) running the Alethia control
plane. One of the per-cloud `cp-*` siblings — see [`infra/README.md`](../README.md). It ports the
working [`cp-hetzner`](../cp-hetzner) design (Cloudflare Tunnel ingress) to Alibaba Cloud, shaped for
what's best on Alibaba rather than a 1:1 clone.

- **Provider:** Alibaba Cloud (`aliyun/alicloud ~> 1.230`) + Cloudflare (`~> 4.40`). **State:**
  S3-compatible `terraform-state` · key `alibaba-cp/terraform.tfstate` (custom endpoint — see
  `backend.hcl.example`).
- **CI:** `.github/workflows/infra-cp-alibaba.yml` is **validate-only** (`tofu validate` + fmt/
  tflint/Trivy, no backend, no secrets). This repository does not deploy this stack, so CI holds no
  Alibaba Cloud credential for it. Apply it yourself, with short-lived STS credentials (for example
  an `aliyun` CLI profile that assumes a RAM role, `ALICLOUD_PROFILE`) rather than a long-lived
  AccessKey.

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
`cp-hetzner`, so this stack has **no CI `apply` job** (the gated-off one, and the static
`ALICLOUD_*` key it named, were removed on 2026-11-14); the PR `plan` job still validates the
Terraform. To deploy it from CI, add a RAM OIDC role (the [`alibaba-e2e`](../alibaba-e2e) pattern)
first — never a static AccessKey.

## Not managed here — inbound email

Company mail is Google Workspace (#7261). Its apex DNS records (MX, SPF, DKIM, site verification)
are zone-global and are owned by `cp-hetzner/mail.tf`. They are intentionally **not** duplicated
here, so that two stacks do not collide on the shared zone.
