# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# NAMING-001 resource-id length gate (the check warns; the terraform_data precondition blocks).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

locals {
  # Every derived GCP resource id in this template is built from the same stem:
  #
  #   "<environment>-<project_name>"
  #
  # either prefixed with "<kind>-<region-short>-" at the template root (gke_name, cloud_dns_name)
  # or suffixed with "-<kind>" inside a module (memorystore, vpc-network, cloud-armor). The region
  # short-name is always 3 characters, so each id's length is a fixed offset off this one number.
  gcp_name_stem_len = length("${var.environment}-${var.project_name}")

  # The budgets, worst case per resource. GKE is the binding constraint:
  #
  #   GKE cluster        "gke-<3>-<stem>"                          = stem + 8   limit 40  -> stem <= 32
  #   Memorystore Redis  "<project>-<environment>-redis"           = stem + 6   limit 40  -> stem <= 34
  #   VPC firewall       "<project>-<environment>-vpc-allow-…"     = stem + 24  limit 63  -> stem <= 39
  #   Cloud Armor        "<project>-<environment>-armor-policy"    = stem + 13  limit 63  -> stem <= 50
  #   Cloud DNS zone     "dns-<3>-<stem>"                          = stem + 8   limit 63  -> stem <= 55
  #
  # 30 is the shipped contract — below every limit, with headroom for a new suffix.
  #
  # The GKE default NODE POOL is deliberately absent from this table. It is the cluster name plus a
  # fixed 13 characters against a limit of 39, which would force stem <= 18 and reject ordinary names
  # like `production`/`alethia-nl`. That one is solved by CONSTRUCTION instead — see
  # gke_node_pool_name below — so it imposes no budget here. See #1716: the readable form 400'd
  # MID-APPLY, after the cluster and network existed, because nothing validated it and this stem
  # check passed at 22 characters.
  gcp_name_stem_max = 30

  # GKE rejects a node-pool name of 40 characters or more:
  #   Error 400: Node_pool.name must be less than 40 characters., badRequest
  # The suffixed form is the cluster name plus a fixed 13 characters, and the cluster name is
  # itself "gke-<region-short>-<environment>-<project_name>" (8 + the naming stem), so the plain
  # concatenation only fits while `len(environment) + len(project_name) <= 18`. Ordinary names blow
  # that: `alethia-nl` + `production` renders 42 characters, and the e2e nightly's own
  # `<run_id>-<attempt>` environment (13 characters) overflows with any project name over 5. The
  # cluster and the VPC are created first, so the 400 lands MID-APPLY and leaves a half-built
  # environment behind (#1716).
  #
  # So derive the name defensively: keep the readable form whenever it fits, and fall back to a
  # deterministic truncation-plus-digest of at most 39 characters (31 + "-" + 7, one fewer when the
  # truncation lands on a hyphen and it is trimmed). Digesting the FULL name rather than the
  # truncated stem is what keeps two clusters sharing a 31-character prefix from colliding.
  #
  # This is backward-compatible by construction: every name the fallback produces is one the GKE API
  # currently REJECTS, so no node pool that exists today can change name — and a rename would force
  # replacement of the pool. Names that fit stay byte-identical.
  #
  # It lives HERE, at the template root, rather than in modules/gke where it is consumed, for one
  # reason: it has to be TESTABLE. The gke module cannot be planned under mocked providers at all —
  # `master_auth` is computed-only and OpenTofu 1.12 populates it through neither
  # `mock_resource.defaults` nor `override_resource.values` — so a test can never reach a local
  # inside it. At the root it is plain string arithmetic over variables, decided before any resource
  # exists, which is the same property NAMING-001 relies on and is what lets
  # checks_naming.tftest.hcl assert it directly. The module takes the finished name as an input.
  gke_node_pool_full = "${local.gke_name}-default-pool"
  gke_node_pool_name = length(local.gke_node_pool_full) < 40 ? local.gke_node_pool_full : format(
    "%s-%s",
    trimsuffix(substr(local.gke_node_pool_full, 0, 31), "-"),
    substr(sha256(local.gke_node_pool_full), 0, 7),
  )
}

# NAMING-001: surface an over-long stem loudly at plan time. A `check` block only WARNS, so the hard
# gate is the terraform_data precondition below; this states the same violation in the plan output.
check "gcp_name_stem_within_limit" {
  assert {
    condition     = local.gcp_name_stem_len <= local.gcp_name_stem_max
    error_message = "NAMING: environment-project_name is ${local.gcp_name_stem_len} chars (max ${local.gcp_name_stem_max}); derived GCP resource ids overflow their caps once suffixed. terraform_data.gcp_naming_guard blocks apply."
  }
}

# Fail-closed apply gate (NAMING-001): an over-long stem hard-fails the plan here, so a GKE cluster
# id that the GCP API would reject can never reach an apply. Both operands are plain variables, so
# this is decided at PLAN time — before any resource exists, which is the whole point: the failure
# this replaces landed after the cluster and VPC were already created and left a half-built
# environment behind. `check` blocks only warn — a `terraform_data` lifecycle precondition is the
# actual gate (same pairing as terraform_data.compat_k8s_guard / rds_engine_shape_guard on aws).
# No bypass variable: a shorter environment or project name is the fix, not a waiver.
resource "terraform_data" "gcp_naming_guard" {
  lifecycle {
    precondition {
      condition     = local.gcp_name_stem_len <= local.gcp_name_stem_max
      error_message = "NAMING-001: environment-project_name (\"${var.environment}-${var.project_name}\") is ${local.gcp_name_stem_len} chars, over the ${local.gcp_name_stem_max}-char budget. Apply blocked fail-closed — the GKE cluster id \"gke-<region>-<environment>-<project_name>\" would exceed its 40-char cap. Shorten the environment or project name."
    }
  }
}
