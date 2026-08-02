# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Classification / cost-sweep label invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# Platform base labels must WIN over classification_tags: for every base key, the merged
# gcp_default_labels must carry the base value (never a classification override). Guards the merge
# direction so a renamed classification dimension can never shadow platform bookkeeping.
check "classification_base_labels_win" {
  assert {
    condition = alltrue([
      for k, v in local.gcp_base_labels : local.gcp_default_labels[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base label in gcp_default_labels; base labels must sit on the merge RHS and win."
  }
}

# No classification label may be silently dropped: every key in var.classification_tags must survive
# into the merged map verbatim, unless a platform base key legitimately overrode it. This lands the
# mandatory alethia_project-id / alethia_environment-id sweep handles on the labelled resources.
check "classification_labels_present" {
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.gcp_default_labels[k] == v || contains(keys(local.gcp_base_labels), k)
    ])
    error_message = "A classification_tags entry was dropped from gcp_default_labels; classification/sweep-handle labels must reach labelled resources."
  }
}
