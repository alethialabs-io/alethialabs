# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Classification + cost-sweep tagging invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# Platform base tags must WIN over classification_tags: for every base key, the merged
# aws_default_tags must carry the base value (never a classification override). This guards the
# merge direction so a renamed classification dimension can never shadow platform bookkeeping.
check "classification_base_tags_win" {
  assert {
    condition = alltrue([
      for k, v in local.aws_base_tags : local.aws_default_tags[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base tag in aws_default_tags; base tags must sit on the merge RHS and win."
  }
}


# No classification tag may be silently dropped: every key in var.classification_tags must survive
# into the merged map verbatim, unless a platform base key legitimately overrode it. This lands the
# mandatory alethia:project-id / alethia:environment-id sweep handles on the tagged resources.
check "classification_tags_present" {
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.aws_default_tags[k] == v || contains(keys(local.aws_base_tags), k)
    ])
    error_message = "A classification_tags entry was dropped from aws_default_tags; classification/sweep-handle tags must reach tagged resources."
  }
}


# Karpenter-launched EC2 do NOT inherit the provider default_tags (Karpenter creates them via its
# own AWS API calls), so they only carry the sweep handle if the EC2NodeClass spec.tags is stamped
# from the `karpenter_node_tags` output (= local.aws_default_tags). Assert here that when Karpenter
# is enabled the classification/sweep-handle tags are all present in aws_default_tags, so the output
# can never ship without them and Karpenter EC2 can never escape the environment-scoped sweeper.
# (This is the plan-time invariant; whether the renderer actually applies spec.tags is proven by the
# A1.3 sweeper / A0.3-style cloud-side check on a real apply.)
check "karpenter_node_tags_carry_sweep_handle" {
  assert {
    condition = !var.enable_karpenter || alltrue([
      for k, v in var.classification_tags :
      local.aws_default_tags[k] == v || contains(keys(local.aws_base_tags), k)
    ])
    error_message = "Karpenter is enabled but classification/sweep-handle tags are not fully present in aws_default_tags (the karpenter_node_tags output); Karpenter-launched EC2 would escape the environment-scoped sweeper."
  }
}
