# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

locals {
  # Platform base tags applied to every taggable resource. Classification + sweep-handle tags
  # (var.classification_tags) are merged in UNDER these — base tags sit on the merge RHS so they
  # always WIN a key collision, keeping the sweep handles and platform bookkeeping authoritative.
  common_base_tags = {
    environment = var.environment
    service     = var.project_name
    managed-by  = "opentofu"
  }

  common_tags = merge(var.classification_tags, local.common_base_tags)

  # Naming conventions (kept short — Alibaba resource names are length-limited).
  name_prefix  = "${var.project_name}-${var.environment}"
  vpc_name     = "vpc-${local.name_prefix}"
  ack_name     = "${var.project_name}-${var.environment}"
  rds_name     = "rds-${local.name_prefix}"
  kvstore_name = "redis-${local.name_prefix}"
  # ots_name and cr_name are both DERIVED, not composed — see checks_naming.tf (NAMING-003).
  # Tablestore caps instance names at 16 and this composition renders 24 for the e2e fixture
  # (#1884); the registry instance renders 27 against a reported cap of 30 (#1886).
  secret_prefix  = local.name_prefix
  vswitch_prefix = "vsw-${local.name_prefix}"

  # ── Node system-disk performance, resolved against the disk category ──────────────────────────
  # Alibaba splits what AWS spells as one `iops` number into two arguments, each honored on exactly
  # one disk category, and the API ACCEPTS the one that does not belong and drops it. So the choice
  # of which argument to send is made here, once, and modules/cluster assigns the result verbatim.
  #
  # Hoisted to the root rather than left in the module because `tofu test` can read `local.` in an
  # assert and cannot reach into a module: a derivation that decides whether a customer's paid-for
  # performance figure is transmitted at all has to be reachable from a test. checks_cluster.tf
  # already refuses the mismatched pairing outright, so in practice these ternaries never fire —
  # they are what makes "never sent where it would be dropped" true by construction rather than by
  # the gate alone.
  #
  # "PL<n>" and not the bare integer: the API takes the string spelling, and a variable typed as a
  # number is what a person configuring a PL tier actually has in hand.
  ack_system_disk_performance_level = (
    var.ack_disk_category == "cloud_essd" && var.ack_disk_performance_level != null
    ? "PL${var.ack_disk_performance_level}"
    : null
  )
  ack_system_disk_provisioned_iops = (
    var.ack_disk_category == "cloud_auto" ? var.ack_disk_provisioned_iops : null
  )

  # Bid ceilings are read only under SpotWithPriceLimit. Emptied for every other strategy so the
  # module renders no spot_price_limit block at all — an on-demand pool plans exactly as before.
  ack_spot_price_limits = (
    var.ack_node_capacity_type == "SpotWithPriceLimit" ? var.ack_spot_price_limit : []
  )
}
