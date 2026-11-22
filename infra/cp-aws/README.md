<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-aws

AWS control-plane box (single x86 EC2 instance) running the Alethia control plane. One of the
per-cloud `cp-*` siblings — see [`infra/README.md`](../README.md). It ports the working
[`cp-hetzner`](../cp-hetzner) design (Cloudflare Tunnel ingress) to AWS, shaped for what's best on
AWS rather than a 1:1 clone.

- **Provider:** AWS (`hashicorp/aws ~> 5.0`) + Cloudflare (`~> 4.40`). **State:** S3-compatible
  `terraform-state` · key `aws-cp/terraform.tfstate` (custom endpoint — see `backend.hcl.example`).
- **CI:** `.github/workflows/infra-cp-aws.yml` is **validate-only** (`tofu validate` + fmt/tflint/
  Trivy, no backend, no secrets). This repository does not deploy this stack, so CI holds no AWS
  credential for it. Apply it yourself, with short-lived credentials (`AWS_PROFILE` from
  `aws sso login`) rather than a long-lived access key.

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```

## Architecture — why it's shaped this way

- **Ingress: Cloudflare Tunnel, no public web ports.** `cloudflared` (a compose service on the box)
  dials **out** to Cloudflare; the security group has **no inbound rules at all**. Apex + `www` are
  **proxied** CNAMEs onto `<tunnel_id>.cfargotunnel.com`; TLS terminates at Cloudflare's edge. The
  connector uses the remotely-managed config (`config_src = "cloudflare"`) and only needs
  `tunnel_token` (exported as the `TUNNEL_TOKEN` env the compose `cloudflared` reads).
- **SSH: SSM Session Manager — no bastion, no open port.** The instance carries a least-priv IAM
  profile (`AmazonSSMManagedInstanceCore` only); the SSM agent (preinstalled on the Ubuntu AMI) dials
  out, so there is **no inbound SSH**. Connect with:
  ```bash
  aws ssm start-session --target <instance_id>
  ```
- **Egress: an auto-assigned public IP, unrestricted outbound.** The box needs outbound (image pulls,
  `git clone`, tunnel + SSM dial-out); an auto-assigned public IP is the cheapest path. A NAT gateway
  (~$32/mo) or a set of SSM VPC interface endpoints (~$21/mo) would be wasteful for a single box. The IP
  is **egress-only**: inbound web is tunnel-fronted and the SG denies all inbound. Trivy flags the
  unrestricted egress (`AVD-AWS-0104`) — that one finding is a reviewed, documented suppression in
  [`infra/.trivyignore`](../.trivyignore): the destinations (GHCR/CDNs, git, the Cloudflare + SSM edge)
  are large and dynamic, so pinning CIDRs would break pulls, and a closed-inbound single box is an
  origin, not a pivot.
- **Hardening:** **IMDSv2 required** (`http_tokens = "required"`), **encrypted** gp3 root EBS, a
  dedicated least-priv instance role (SSM core only — not a broad policy), and an ingress-free SG.
  Invariants are asserted in `checks.tf`.
- **Durability:** the encrypted root EBS holds Docker's data-root (Postgres + object storage) and is
  snapshottable — no separate data volume.

## One control-plane at a time

The `cp-*` siblings all serve the **same domain/zone**. They are alternatives — apply **one instead of
another**, never two at once (two would fight over the apex DNS + tunnel). Prod currently runs on
`cp-hetzner`, so this stack has **no CI `apply` job** (the gated-off one, and the static AWS key it
named, were removed on 2026-11-14); the PR `plan` job still validates the Terraform. To deploy it
from CI, add a GitHub OIDC role in `infra/aws-oidc/roles.tf` (the `alethia-cp-deployer` pattern)
first — never a static key.

## Not managed here — inbound email

Company mail is Google Workspace (#7261). Its apex DNS records (MX, SPF, DKIM, site verification)
are zone-global and are owned by `cp-hetzner/mail.tf`. They are intentionally **not** duplicated
here, so that two stacks do not collide on the shared zone.
