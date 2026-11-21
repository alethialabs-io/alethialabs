# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# https://assets.alethialabs.io — one public host for the media every app links to (films, posters,
# the founder photo, brand files), served from a Cloudflare R2 bucket through an R2 custom domain.
#
# Why R2 and not the S3 bucket connector-assets/ uses: egress. A 60–90 s film is tens of MB and is
# played by every visitor to the home page; R2 charges nothing for egress and the custom domain puts
# Cloudflare's cache in front of it, while S3 + CloudFront would bill per GB served. Storage for this
# set is well inside R2's free 10 GB (README.md, "Cost").
#
# Applied by the maintainer only. See README.md for the runbook, the token's permissions and the
# upload convention.

locals {
  # Only these prefixes get the long edge TTL. Every object under them must have a content-hashed or
  # versioned filename (README.md, "Path convention"), because a cached object cannot be changed in
  # place for a year — a new version is a new name.
  immutable_prefixes = ["/brand/", "/media/", "/people/"]

  # One year, the longest edge TTL Cloudflare accepts on a cache rule.
  one_year = 31536000
}

data "cloudflare_zone" "this" {
  filter = {
    name    = var.zone_name
    account = { id = var.cloudflare_account_id }
  }
}

# The bucket. `location = "eeur"` is a placement hint and `jurisdiction = "eu"` is the guarantee: the
# objects are stored in the EU, consistent with docs/legal/GDPR_ACCOUNTABILITY.md. Both are fixed at
# creation — changing either later is a new bucket, which prevent_destroy forces to be deliberate.
resource "cloudflare_r2_bucket" "assets" {
  account_id   = var.cloudflare_account_id
  name         = var.bucket_name
  location     = "eeur"
  jurisdiction = "eu"

  lifecycle {
    # The films and photos in here exist nowhere else in a servable form; a destroy loses them and
    # breaks every URL already published.
    prevent_destroy = true
  }
}

# The public face of the bucket. Cloudflare creates and manages the host's DNS record and certificate
# itself; the host must have no record already (README.md, step 1).
resource "cloudflare_r2_custom_domain" "assets" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.assets.name
  jurisdiction = cloudflare_r2_bucket.assets.jurisdiction
  domain       = var.hostname
  zone_id      = data.cloudflare_zone.this.zone_id
  enabled      = true
  min_tls      = "1.2"

  lifecycle {
    precondition {
      condition     = endswith(var.hostname, ".${var.zone_name}")
      error_message = "hostname ${var.hostname} must be inside the ${var.zone_name} zone."
    }
  }
}

# The bucket's r2.dev URL, explicitly OFF. That URL bypasses the custom domain's cache and its TLS
# floor and is rate limited; nothing should ever link it.
resource "cloudflare_r2_managed_domain" "assets" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.assets.name
  jurisdiction = cloudflare_r2_bucket.assets.jurisdiction
  enabled      = false
}

# Read-only cross-origin access for the site's own origins. A plain <img>/<video> needs none of this;
# it is for code that reads the bytes (a font, fetch(), a <video crossorigin> poster frame).
resource "cloudflare_r2_bucket_cors" "assets" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.assets.name
  jurisdiction = cloudflare_r2_bucket.assets.jurisdiction

  rules = [{
    id = "site-read"
    allowed = {
      methods = ["GET", "HEAD"]
      origins = var.cors_origins
      headers = ["Range"]
    }
    # Range requests are how a browser seeks in a video; the player needs to read these back.
    expose_headers  = ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"]
    max_age_seconds = 86400
  }]
}

# The zone's cache-settings entrypoint. A zone holds ONE ruleset per phase, so this owns every cache
# rule on alethialabs.io — which is why it is gated on a committed, required decision
# (var.manage_cache_rule) and why README.md step 1 checks the dashboard first.
resource "cloudflare_ruleset" "cache" {
  count = var.manage_cache_rule ? 1 : 0

  zone_id     = data.cloudflare_zone.this.zone_id
  name        = "Cache settings (owned by infra/assets-cdn)"
  description = "Cache rules for alethialabs.io. Owned by OpenTofu (infra/assets-cdn); dashboard edits are overwritten on apply."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [{
    ref         = "assets_immutable"
    description = "assets.${var.zone_name}: versioned media, cached for a year at the edge"
    expression = format(
      "(http.host eq \"%s\" and (%s))",
      var.hostname,
      join(" or ", [for p in local.immutable_prefixes : "starts_with(http.request.uri.path, \"${p}\")"]),
    )
    action  = "set_cache_settings"
    enabled = true
    action_parameters = {
      cache = true
      edge_ttl = {
        mode    = "override_origin"
        default = local.one_year
        # A 404 must not be cached for a year: a page deployed a minute before its file was uploaded
        # would otherwise serve a broken image long after the upload. Errors live for one minute.
        status_code_ttl = [{
          status_code_range = { from = 400, to = 599 }
          value             = 60
        }]
      }
      # The browser follows the object's own Cache-Control, which the upload convention sets to
      # `public, max-age=31536000, immutable` (README.md).
      browser_ttl = { mode = "respect_origin" }
    }
  }]
}
