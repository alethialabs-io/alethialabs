# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Adoption of DNS records that already exist in the zone into this stack's state.
#
# get.<domain> was created by hand (a proxied CNAME onto this stack's tunnel) before
# `cloudflare_record.get` in main.tf was applied. Without this block the next apply tries to
# CREATE the record, Cloudflare answers "record already exists", and the apply fails, because the
# resource does not set `allow_overwrite`. Importing adopts the live record instead; the plan then
# reads "1 to import" for it, plus an in-place update only if the live record differs from the
# declaration.
#
# The record id is not account data (a DNS record id grants nothing without a token), and the
# zone id comes from the same input every other record here uses.
#
# AFTER ADOPTION this block is inert: an import whose target is already in state is skipped. It can
# be deleted in any later PR once the apply has run.

import {
  to = cloudflare_record.get
  id = "${var.cloudflare_zone_id}/846af65c93a2ffc5e20a0919bf009ed4"
}
