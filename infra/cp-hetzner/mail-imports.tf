# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Adoption of the LIVE Google Workspace apex records (mail.tf) into this stack's state (#7261).
#
# These records were created by hand on 2026-11-22. Without these blocks the first apply would try
# to CREATE them a second time, and Cloudflare refuses an identical record (error 81058), failing
# the apply. An import whose target is already in state is skipped, so after the first apply these
# blocks are inert.
#
# The record IDs are Cloudflare's DNS record tags, read from
# GET /zones/{zone_id}/dns_records?type=TXT on 2026-11-22. They are identifiers, not credentials:
# nothing can be done with one without an API token for the zone. If a record is deleted and
# re-created before the first apply, its ID changes and the import fails the PLAN with "Cannot
# import non-existent remote object" — re-read the ID (README) and update it here.

import {
  to = cloudflare_record.mail_spf
  id = "${var.cloudflare_zone_id}/cb8cdf60c2adcbe16fb8d5a885ff1ce9"
}

import {
  to = cloudflare_record.mail_dkim_google
  id = "${var.cloudflare_zone_id}/bf5cde474e7296352c0ce016b449b29b"
}

import {
  to = cloudflare_record.mail_google_site_verification
  id = "${var.cloudflare_zone_id}/bb3a11890e953224307abb160521122a"
}

# The MX is the one record whose live existence is not settled at the time of writing: at
# 2026-11-22T21:13Z Cloudflare Email Routing re-synced and put its own route{1,2,3}.mx.cloudflare.net
# records back on the apex, and the hand-made `MX 1 smtp.google.com` was no longer there. So its ID
# is an INPUT, not a literal:
#   · var.mail_mx_record_id unset ("")  → no import; the apply CREATES the MX. Right when no
#     smtp.google.com MX exists on the apex.
#   · set (APEX_MX_RECORD_ID in alethia/prod/env) → the live record is imported. Required when the MX
#     was re-added by hand before the apply — otherwise the create collides with it (error 81058)
#     and the apply fails, loudly, without changing anything else about the record.
import {
  for_each = var.mail_mx_record_id != "" ? { "0" = var.mail_mx_record_id } : {}

  to = cloudflare_record.mail_mx_google
  id = "${var.cloudflare_zone_id}/${each.value}"
}
