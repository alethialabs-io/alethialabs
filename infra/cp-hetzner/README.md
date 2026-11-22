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

## Company mail — Google Workspace (#7261)

Mail for the `alethialabs.io` apex is Google Workspace, since 2026-11-22. `mail.tf` declares the
four apex records Workspace needs, and `mail-imports.tf` adopts the live ones:

| Record | Value | Adopted by |
|---|---|---|
| `MX` `@` | `1 smtp.google.com` | import when `APEX_MX_RECORD_ID` is set, otherwise created |
| `TXT` `@` | `v=spf1 include:_spf.google.com ~all` | import, literal id |
| `TXT` `google._domainkey` | Google DKIM, 2048-bit | import, literal id |
| `TXT` `@` | `google-site-verification=…` | import, literal id |

The apex addresses the product prints (`support@`, `sales@`, `legal@`, `privacy@`, `security@`,
`feedback@`, `dmarc@`) are aliases of one Workspace user, configured in the Workspace admin console.
Google rejects unknown local-parts. There is no catch-all. `_dmarc` is unchanged and is not declared here.

**SES is not affected.** `infra/email-ses` sends from its own Easy DKIM selectors with the default
`amazonses.com` MAIL FROM, and reads nothing from the apex MX or SPF. Do not add an SES or
Cloudflare `include:` to the apex SPF.

### Cloudflare Email Routing is retired

`email-routing.tf` and `email-routing-imports.tf` are deleted, together with the
`manage_email_routing` / `email_forward_to` / `email_routing_address_id` / `email_routing_rule_ids`
inputs and the workflow lines that loaded them. `removed { lifecycle { destroy = false } }` blocks
in `mail.tf` make sure that no apply calls Cloudflare to delete the routing objects. None of them is
expected to be in state, so those blocks are expected to be a no-op.

Email Routing itself is still **enabled** on the zone, and OpenTofu cannot switch it off.
While it is enabled, Cloudflare puts back its own locked `route{1,2,3}.mx.cloudflare.net` apex MX
records each time the routing re-syncs. That happened at 2026-11-22T21:13Z. Those records are
read-only through the DNS API, so they compete with `smtp.google.com`. Disable it once:
Cloudflare dashboard → *Email* → *Email Routing* → *Settings* → *Disable Email Routing*, and let
it remove the DNS records it offers to remove. Then confirm that only Google is left, and delete
any `route*.mx.cloudflare.net` MX that is still there:

```sh
dig +short MX alethialabs.io     # expect exactly: 1 smtp.google.com.
dig +short TXT alethialabs.io    # expect the Google SPF + site-verification, nothing else mail-related
```

### Looking up a record id

Use this to re-read an id that `mail-imports.tf` cannot find, or to get the `APEX_MX_RECORD_ID`
of an MX added by hand. The token needs DNS read on the zone:

```sh
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?per_page=100" \
  | jq -r '.result[] | select(.type == "MX" or .type == "TXT") | [.id, .type, .name, .content] | @tsv'
```

Here, run it as `pnpm creds prod-env -- bash -c '…'`, so the token stays in the child's
environment.

**Inbound support mail to the console** (MAIL-S1 #7246 / MAIL-L3 #7250) does not use the apex. A
Workspace routing rule also delivers `support@` to a Cloudflare-handled subdomain, such as
`inbound.alethialabs.io`. That subdomain has its own MX to Cloudflare and an Email Worker behind it.
**Open question for MAIL-L3:** Cloudflare's subdomain routing lives under the zone's Email Routing,
and that is the feature which put the apex MX back. Before re-enabling it for a subdomain, prove
that the apex MX stays `smtp.google.com` afterwards. If it does not, the inbound host needs a zone
of its own.
