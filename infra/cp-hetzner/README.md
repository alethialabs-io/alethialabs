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

> **Terraform does not manage this until the maintainer adopts it (#3291, #4374).**
> `var.manage_email_routing` defaults to `false` and none of the 11 resources below is in this
> stack's state — the live routing was bootstrapped out-of-band. The adoption is wired
> (`email-routing-imports.tf` + optional loads in `infra-cp-hetzner.yml`) but does nothing until
> the four secret keys below exist. Read `manage_email_routing`'s description in `variables.tf`
> first: once adopted, removing the keys plans a **destroy** of live inbound mail.

### Adopting the live routing (#4374)

Nine of the 11 resources are imported; the settings and catch-all singletons have no importer in
provider 4.x and are adopted by a create that is idempotent against the live objects
(`email-routing-imports.tf` says why). So the adoption plan reads
**`9 to import, 2 to add, 0 to change, 0 to destroy`**.

1. **List the IDs** (token with Email Routing read on the account and zone):

   ```sh
   # destination address — take the `id` of the entry whose `email` is the forward inbox
   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/email/routing/addresses" \
     | jq '.result[] | {id, email, verified}'
   # the 8 forward rules — key each `id` by the local-part of its matcher value
   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/email/routing/rules?per_page=50" \
     | jq '[.result[] | select(.matchers[0].type == "literal")
            | {key: (.matchers[0].value | split("@")[0]), value: .id}] | from_entries'
   # for comparison only (not imported): zone settings and the catch-all
   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/email/routing" | jq .result
   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/email/routing/rules/catch_all" | jq .result
   ```

   Check the live objects match `email-routing.tf`: rule names `forward-<local-part>`, exactly the 8
   local-parts in `local.adopted_addresses`, catch-all `drop-unmatched` with action `drop`.

2. **Add four keys to the `alethia/prod/env` secret** (eu-central-1): `MANAGE_EMAIL_ROUTING` =
   `"true"`, `EMAIL_FORWARD_TO` = the live destination `email` exactly (it forces replacement),
   `EMAIL_ROUTING_ADDRESS_ID` = the address `id`, and `EMAIL_ROUTING_RULE_IDS` = the JSON object
   from the second call (a JSON object or a string holding one both work).

3. **Plan locally** with the same values (`TF_VAR_manage_email_routing=true`,
   `TF_VAR_email_forward_to=…`, `TF_VAR_email_routing_address_id=…`,
   `TF_VAR_email_routing_rule_ids='{"support":"…",…}'`, plus the five usual inputs) and
   `tofu init -backend-config=backend.hcl && tofu plan`. It must read
   `9 to import, 2 to add, 0 to change, 0 to destroy` for the email-routing addresses (other
   resources in this stack must show no change). Anything to change or destroy means the
   declaration disagrees with the live routing — fix the declaration, not the live routing.

4. The next `main` apply of this stack (a push touching `infra/cp-hetzner/**`) performs the
   adoption. The keys stay in the secret from then on.

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
