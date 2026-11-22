# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# status.alethialabs.io — the public status page, provisioned end to end (#7148).
#
# This stack owns EVERY Cloudflare object behind the hostname: the D1 database (history), the KV
# namespace (the rendered snapshot), the Worker script and its bindings, the cron trigger, the DNS
# record and the route. Applying it on a fresh account produces a working page with no
# `wrangler d1 create`, no id pasted into a config file and no `wrangler secret put`. The Worker's
# code is packages/status; its runbook (build, apply, the console-side secret) is
# packages/status/README.md.
#
# WHY CLOUDFLARE AND NOT OUR BOX. A status page inside the failure domain it reports on is silent in
# exactly the incident it exists for. This replaces a Gatus VPS on Hetzner (this directory's previous
# contents, plus deploy/status/) that was never applied.
#
# WHY NOT WRANGLER. Two owners for one script is the failure infra/e2e-issuer's header warns about.
# `cloudflare_workers_script` takes the bundle as a file, so the only thing OpenTofu cannot do is
# bundle TypeScript — `pnpm -F @repo/status build` does that, before the plan.
#
# PROD ONLY. There is no staging status page: a second page reporting an environment no customer
# reads dilutes the one that matters.
#
# APPLIED BY THE MAINTAINER, never by CI (.github/workflows/infra-status.yml validates only): the apply
# token needs account-level Workers/KV/D1 scopes no CI job holds.

locals {
  script_name = "alethia-status"

  # Relative to path.module, NOT to the caller's working directory — `file()` resolves a bare relative
  # path against tofu's cwd, so the default would break under `-chdir`.
  bundle_path   = "${path.module}/${var.worker_bundle_path}"
  bundle_exists = fileexists(local.bundle_path)
  # Guarded so `tofu validate` (CI, no build) does not fail on the missing bundle; the precondition on
  # the script turns a missing or empty bundle into a plan-time error with the fix in it.
  bundle_sha256 = local.bundle_exists ? filesha256(local.bundle_path) : ""
  bundle_size   = local.bundle_exists ? length(file(local.bundle_path)) : 0

  # Must match the Worker's own constant (packages/status/src/render.ts SITE): every link the page
  # emits, the sitemap and the canonical URL are built from it.
  status_url = "https://${var.hostname}"
}

# Looked up by NAME and filtered by ACCOUNT (the infra/e2e-issuer pattern), so the id is never
# hand-copied and a same-named zone in another account cannot be matched.
data "cloudflare_zone" "this" {
  filter = {
    name    = var.zone_name
    account = { id = var.cloudflare_account_id }
  }
}

# ── stores ───────────────────────────────────────────────────────────────────

# History. `checks` is a one-hour rolling window for the incident state machine; `daily` is the 90-day
# rollup the uptime bar reads. The Worker applies its own schema (packages/status/src/schema.ts) —
# OpenTofu has no D1 query resource, and every statement is IF NOT EXISTS. Being a separate resource
# from the script is what makes history survive a Worker redeploy.
resource "cloudflare_d1_database" "status" {
  account_id = var.cloudflare_account_id
  name       = local.script_name

  lifecycle {
    # The 90 days of history live here and nowhere else. Replacing this resource erases them.
    prevent_destroy = true
  }
}

# The pre-rendered page + JSON, one key. Read once per request by `fetch()`, which has a 10 ms CPU
# budget on the free plan — far too little to query D1 and template a page.
resource "cloudflare_workers_kv_namespace" "snapshot" {
  account_id = var.cloudflare_account_id
  title      = "${local.script_name}-snapshot"
}

# ── the Worker ───────────────────────────────────────────────────────────────

resource "cloudflare_workers_script" "status" {
  account_id     = var.cloudflare_account_id
  script_name    = local.script_name
  content_file   = local.bundle_path
  content_sha256 = local.bundle_sha256
  main_module    = "worker.js"
  # `nodejs_compat` is deliberately absent — nothing here needs a Node shim.
  compatibility_date = "2026-11-01"

  bindings = [
    {
      name        = "DB"
      type        = "d1"
      database_id = cloudflare_d1_database.status.id
    },
    {
      name         = "SNAPSHOT"
      type         = "kv_namespace"
      namespace_id = cloudflare_workers_kv_namespace.snapshot.id
    },
    {
      # The bearer the console's /api/health accepts for one boolean per component. The SAME value is
      # ALETHIA_STATUS_PROBE_TOKEN in alethia/prod/env. Stored in this stack's state (encrypted S3).
      name = "STATUS_PROBE_TOKEN"
      type = "secret_text"
      text = var.status_probe_token
    },
  ]

  lifecycle {
    precondition {
      condition     = local.bundle_exists && local.bundle_size > 0
      error_message = "The Worker bundle at ${local.bundle_path} is missing or empty. Cloudflare accepts an empty script and then serves errors, so this fails at plan time instead. Run `pnpm -F @repo/status build` before `tofu plan`."
    }
  }
}

# Every minute. The free plan allows 5 cron triggers per account; this is one.
# `schedules` is the COMPLETE set for this script — a schedule missing here is deleted on apply.
resource "cloudflare_workers_cron_trigger" "status" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.status.script_name
  schedules   = [{ cron = "* * * * *" }]
}

# ── the hostname ─────────────────────────────────────────────────────────────

# A Workers route binds to a hostname that RESOLVES and is PROXIED; the address behind it is never
# contacted. TEST-NET-1 is unroutable on purpose, so a misconfiguration fails loudly instead of
# reaching a stranger.
#
# Must NOT exist before the first apply: on 2026-11-21 status.alethialabs.io had no DNS record, which
# is why the console stopped linking it. If a hand-made record for this name ever appears, delete it
# rather than importing it — a record beside a managed one is two owners for one hostname.
resource "cloudflare_dns_record" "status" {
  zone_id = data.cloudflare_zone.this.zone_id
  name    = var.hostname
  type    = "A"
  content = "192.0.2.1" # TEST-NET-1; served by the Worker route, never by this address
  proxied = true        # a Workers route only binds to a proxied hostname
  ttl     = 1           # automatic; required when proxied
  comment = "status page (served by the ${local.script_name} Worker) — managed by infra/status (#7148)"

  lifecycle {
    precondition {
      condition     = endswith(var.hostname, ".${var.zone_name}")
      error_message = "hostname ${var.hostname} is not a subdomain of ${var.zone_name}."
    }
  }
}

resource "cloudflare_workers_route" "status" {
  zone_id = data.cloudflare_zone.this.zone_id
  pattern = "${var.hostname}/*"
  script  = cloudflare_workers_script.status.script_name
}
