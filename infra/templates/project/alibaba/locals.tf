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
  name_prefix    = "${var.project_name}-${var.environment}"
  vpc_name       = "vpc-${local.name_prefix}"
  ack_name       = "${var.project_name}-${var.environment}"
  rds_name       = "rds-${local.name_prefix}"
  kvstore_name   = "redis-${local.name_prefix}"
  ots_name       = replace("ots${var.project_name}${var.environment}", "-", "")
  cr_name        = replace("cr-${local.name_prefix}", "_", "-")
  secret_prefix  = local.name_prefix
  vswitch_prefix = "vsw-${local.name_prefix}"
}
