# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Classification / cost-sweep label invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "classification_base_labels_win" {
  # Platform base labels must WIN over classification_tags: for every base key, the merged
  # default_labels must carry the base value. This keeps `cluster` (the label the SHARED-with-prod
  # teardown sweep scopes on) authoritative — a renamed classification dimension can never shadow it.
  assert {
    condition = alltrue([
      for k, v in local.base_labels : local.default_labels[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base label in default_labels; base labels must sit on the merge RHS and win (notably `cluster`)."
  }
}

check "classification_labels_present" {
  # No classification label may be silently dropped: every key in var.classification_tags must
  # survive into default_labels verbatim, unless a base key legitimately overrode it. This lands the
  # mandatory alethia_project-id / alethia_environment-id sweep handles on every hcloud resource.
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.default_labels[k] == v || contains(keys(local.base_labels), k)
    ])
    error_message = "A classification_tags entry was dropped from default_labels; classification/sweep-handle labels must reach hcloud resources + volumes."
  }
}
