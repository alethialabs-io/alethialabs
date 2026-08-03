# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Storage-tier invariants (CSI StorageClass + Object Storage buckets).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "csi_storageclass_present" {
  # Persistent volumes are required (in-cluster Postgres/Redis/etc). Assert the
  # Hetzner CSI driver + a DEFAULT hcloud-volumes StorageClass are rendered.
  assert {
    condition     = local.csi_has_driver && local.csi_has_storageclass
    error_message = "Hetzner CSI driver + StorageClass must be present in the rendered manifests."
  }

  assert {
    condition     = local.csi_has_default_sc
    error_message = "The hcloud-volumes StorageClass must be marked as the cluster default (is-default-class=true)."
  }

  # NOTE: the volume-label invariant (HCLOUD_VOLUME_EXTRA_LABELS carrying cluster=<name>) is
  # deliberately NOT asserted here. A `check` block only emits a WARNING — it does not fail
  # plan or apply — and that invariant guards a real money leak (an unlabelled pvc-* volume is
  # unreclaimable by the cluster-scoped teardown and bills forever). It is enforced as a
  # HARD failure by the `terraform_data.csi_volume_label_guard` lifecycle precondition in
  # csi.tf. Keep it there; a warning is not a gate.
}

check "bucket_names_non_empty" {
  # Every requested bucket must carry a non-empty name (it becomes part of the S3 bucket
  # name), and S3 credentials must be present when buckets are requested.
  assert {
    condition     = alltrue([for b in var.buckets : length(trimspace(b.name)) > 0])
    error_message = "Every Object Storage bucket must have a non-empty name."
  }

  assert {
    condition     = length(var.buckets) == 0 || (trimspace(var.hetzner_s3_access_key) != "" && trimspace(var.hetzner_s3_secret_key) != "")
    error_message = "Provisioning Hetzner Object Storage buckets requires hetzner_s3_access_key and hetzner_s3_secret_key (generate them in the Hetzner Console — there is no API to mint them)."
  }
}
