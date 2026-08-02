# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Classification / cost-sweep tag invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# Platform base tags must WIN over classification_tags: for every base key, the merged common_tags
# must carry the base value (never a classification override). Guards the merge direction so a
# renamed classification dimension can never shadow platform bookkeeping.
check "classification_base_tags_win" {
  assert {
    condition = alltrue([
      for k, v in local.common_base_tags : local.common_tags[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base tag in common_tags; base tags must sit on the merge RHS and win."
  }
}

# No classification tag may be silently dropped: every key in var.classification_tags must survive
# into the merged map verbatim, unless a platform base key legitimately overrode it. This lands the
# mandatory alethia:project-id / alethia:environment-id sweep handles on the tagged resources.
check "classification_tags_present" {
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.common_tags[k] == v || contains(keys(local.common_base_tags), k)
    ])
    error_message = "A classification_tags entry was dropped from common_tags; classification/sweep-handle tags must reach tagged resources."
  }
}
