<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-hetzner

Hetzner Cloud control-plane box running the Alethia control plane. One of the per-cloud `cp-*`
siblings — see [`infra/README.md`](../README.md). (Distinct from `status/`, the separate Gatus
status-page VPS.)

- **Provider:** Hetzner Cloud (`hcloud`). **State:** S3-compatible `terraform-state` · key
  `hetzner/terraform.tfstate` (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static keys via `.github/workflows/infra-cp-hetzner.yml` (`HCLOUD_TOKEN` +
  `TF_STATE_S3_ACCESS_KEY_ID` / `TF_STATE_S3_SECRET_ACCESS_KEY` for the state backend).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```

## Inbound email — Cloudflare Email Routing (free)

`email-routing.tf` receives at the apex addresses the product prints (`support@`,
`sales@`, `legal@`, `security@`, `feedback@`, `dmarc@`, `borislav@`) and **forwards them
to `var.email_forward_to`**. It coexists with the SES *send* stack (`infra/email-ses`):
SES sends from the `auth.*`/`mail.*` subdomains with their own `bounce.*` MX, while Email
Routing claims the previously-empty **apex MX**. Enabling it also auto-adds the apex MX +
SPF records (priorities are Cloudflare-randomised, so they aren't pinned in code).

The Cloudflare API token needs **Email Routing** perms (Rules — zone, Addresses — account)
on top of the DNS + Tunnel perms it already has.

**One-time after apply:** Cloudflare emails a confirmation link to the destination
(`email_forward_to`) — **click it once** or nothing delivers. Watch delivery under
Cloudflare dashboard → *Email* → *Email Routing*.

**Add / remove a routed address:** edit `local.inbound_addresses` in `email-routing.tf`
and re-apply. Unmatched apex mail is dropped (catch-all) — flip `action.type` to `forward`
to catch-all instead.

**Reply *as* these addresses** (not just receive) is a separate path: the apex
`alethialabs.io` SES identity + `alethia-ses-smtp-gmail` IAM user in `infra/email-ses`,
consumed by `scripts/gmail-inbox/` (Gmail "Send mail as" over SES SMTP).
