# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Adoption of the LIVE Cloudflare Email Routing into this stack's state (#4374).
#
# The routing in email-routing.tf was bootstrapped out-of-band and is serving real mail. These
# `import` blocks let the SAME apply that switches `manage_email_routing` on also take ownership of
# the existing objects, instead of trying to create them a second time. Read
# `manage_email_routing`'s description in variables.tf for why the input and the import must land
# together.
#
# WHAT IS IMPORTED, AND WHAT CANNOT BE. Of the 11 resources in email-routing.tf, NINE are imported
# here: the destination address and the 8 forward rules. The other two cannot be, and this is a
# property of the pinned provider, not a choice: in cloudflare/cloudflare ~> 4.x (checked against
# v4.52.0, the last 4.x) `cloudflare_email_routing_settings` and `cloudflare_email_routing_catch_all`
# are SDKv2 resources with NO Importer, so an import block naming either fails `tofu plan` with
# "resource does not support import". Both are zone-scoped singletons, and both are adopted by
# their CREATE instead:
#   · catch_all's Create IS its Update — a PUT of the zone's one catch-all rule — so "create"
#     overwrites the live rule with the declared one (drop-unmatched, action drop).
#   · settings' Create calls POST /zones/{zone_id}/email/routing/enable on a zone that is already
#     enabled. That call is expected to return the current settings rather than fail, but it has
#     NOT been exercised against this zone — the maintainer's local plan+apply is where it is.
# So the adoption plan reads "9 to import, 2 to add, 0 to change, 0 to destroy", never 11/0/0/0.
#
# GATING. With `manage_email_routing` unset (false), every for_each below is empty and this file
# is a no-op — the dormant default of #3291 is unchanged. The IDs arrive as inputs because they are
# account data, loaded by infra-cp-hetzner.yml from the alethia/prod/env secret, not committed.
#
# AFTER ADOPTION these blocks are inert: an import whose target is already in state is skipped. The
# IDs must still stay in the secret, because the preconditions in email-routing.tf read them — they
# are what stops a flipped input with MISSING IDs from planning a second copy of a live object.

import {
  # A single-element map when managed, so the one import has a key; empty otherwise.
  for_each = var.manage_email_routing ? { "0" = var.email_routing_address_id } : {}

  to = cloudflare_email_routing_address.dest[tonumber(each.key)]
  id = "${var.cloudflare_account_id}/${each.value}"
}

import {
  # Keyed by local-part ("support", "sales", …), matching the for_each keys of the rule resource.
  # A key that is not in local.inbound_addresses fails the plan ("configuration for import target
  # does not exist"), which is the wanted failure: a typo in the secret must not import nothing.
  for_each = var.manage_email_routing ? var.email_routing_rule_ids : {}

  to = cloudflare_email_routing_rule.inbound[each.key]
  id = "${var.cloudflare_zone_id}/${each.value}"
}
