# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# Hetzner CSI driver (github.com/hetznercloud/csi-driver).
#
# Provides persistent volumes (Hetzner block storage) for in-cluster stateful
# services (CloudNativePG, Redis, ...). The `hcloud-volumes` StorageClass is
# made the cluster DEFAULT. Reuses the same `hcloud` Secret (token) as the CCM.
#
# Rendered offline via `helm_template` and exported via the `bootstrap_manifests` output (talos.tf) and applied post-apply by
# the runner with kubectl — consistent with Cilium/CCM, no in-tofu kubectl provider (so
# `tofu plan -out` stays resolvable).
# ---------------------------------------------------------------------------

locals {
  # Pinned to the NEWEST version that still supports the Kubernetes this template actually
  # builds. Both bounds are load-bearing — do not bump blindly:
  #
  #   FLOOR  v2.15.0 — `controller.volumeExtraLabels` (HCLOUD_VOLUME_EXTRA_LABELS, see the
  #                    volume-labelling block below) arrived in v2.14.0, but upstream marks
  #                    v2.14.0 itself as DO-NOT-INSTALL ("install v2.15.0 or later"). On any
  #                    chart below this the label setting is SILENTLY IGNORED → leaked volumes.
  #   CEILING v2.20.2 — upstream's version-policy table maps k8s 1.32 → v2.20.2 (no "+"): it is
  #                    the LAST release supporting 1.32, and v2.21.0 explicitly "drop[s] support
  #                    for Kubernetes v1.32". This template's talos_version default (v1.9.5)
  #                    ships DefaultKubernetesVersion = 1.32.3, so anything newer than v2.20.2 is
  #                    OUT OF SUPPORT here — and this is the real CUSTOMER provisioning template,
  #                    not just the nightly, so an unsupported CSI driver would land in customer
  #                    clusters (which DO run PVC workloads via the addon catalog).
  #
  # v2.20.2 satisfies both, and carries the 2.20.1/2.20.2 volume-label validation + truncation
  # fixes. Raising this ceiling REQUIRES first moving Talos to a release whose default k8s is
  # >= 1.33 — bump them together, never the chart alone.
  hcloud_csi_version = "2.20.2"
}

data "helm_template" "hcloud_csi" {
  name         = "hcloud-csi"
  namespace    = "kube-system"
  repository   = "https://charts.hetzner.cloud"
  chart        = "hcloud-csi"
  version      = local.hcloud_csi_version
  kube_version = local.render_kube_version

  # Reuse the existing `hcloud` secret (delivered as an inline manifest).
  set {
    name  = "controller.hcloudToken.existingSecret.name"
    value = "hcloud"
  }
  set {
    name  = "controller.hcloudToken.existingSecret.key"
    value = "token"
  }

  # ── Stamp the platform + classification labels on every DYNAMICALLY-provisioned volume. ──
  # A PVC-created hcloud Volume (`pvc-<uuid>`) is created by the CSI CONTROLLER at
  # runtime, not by this template — so it carries none of our labels, and `tofu destroy`
  # (which only knows template-managed resources) does not delete it. Destroying a cluster
  # with live PVCs therefore LEAKS real, billable volumes, and the teardown sweep
  # (scripts/e2e/hcloud-cleanup.sh) could not see them either: its every call is scoped to
  # `cluster=<name>`, and it must stay that way — the hcloud account is SHARED WITH PROD, so
  # sweeping unlabelled `pvc-*` volumes account-wide is exactly the near-miss the
  # scope-destructive-cloud-ops rule forbids.
  #
  # Telling the driver to label what it creates closes the gap at the source: the volumes
  # become label-visible, so the EXISTING cluster-scoped sweep reclaims them with no
  # widening of its blast radius. Requires chart >= 2.14.0 (pinned above).
  #
  # local.default_labels carries the load-bearing `cluster` base label (which the money-guard
  # below still asserts) PLUS the classification + `alethia_project-id`/`alethia_environment-id`
  # sweep handles (B1.3), so a guarded sweeper can scope by environment too. It is passed via
  # `values` (not a `set` block) because classification label keys may contain `.` (valid in the
  # K8s label charset) — a dot in a helm `set` NAME is a path separator and would nest/break the
  # key, whereas a yamlencoded map is immune.
  values = [yamlencode({
    controller = {
      volumeExtraLabels = local.default_labels
    }
  })]

  # Make hcloud-volumes the default StorageClass.
  set {
    name  = "storageClasses[0].name"
    value = "hcloud-volumes"
  }
  set {
    name  = "storageClasses[0].defaultStorageClass"
    value = "true"
  }
  set {
    name  = "storageClasses[0].reclaimPolicy"
    value = "Delete"
  }
}

locals {
  # Detect the default StorageClass in the rendered CSI manifests — used by
  # checks.tf to assert the CSI/StorageClass resources are actually present.
  csi_manifest_yaml = data.helm_template.hcloud_csi.manifest

  csi_has_storageclass = can(regex("kind:\\s*StorageClass", local.csi_manifest_yaml))
  csi_has_default_sc = can(regex(
    "storageclass.kubernetes.io/is-default-class:\\s*\"true\"",
    local.csi_manifest_yaml
  ))
  csi_has_driver = can(regex("csi.hetzner.cloud", local.csi_manifest_yaml))

  # The controller must actually receive HCLOUD_VOLUME_EXTRA_LABELS carrying THIS cluster's
  # label — that is what makes dynamically-provisioned `pvc-*` volumes reclaimable by the
  # cluster-scoped teardown sweep. HARD-ENFORCED via a lifecycle precondition (see the
  # csi_volume_label_guard resource below), because a chart pin outside the supported window,
  # or an upstream rename of the value, would otherwise silently drop the label and start
  # leaking billable volumes with no other signal.
  #
  # strcontains, NOT regex: cluster_name is interpolated from project_name, which permits `.`
  # and `-`. As a regex pattern those are metacharacters, so `a.b` would match `axb` (a false
  # POSITIVE — the guard would pass on the wrong label). A literal substring test cannot.
  csi_has_volume_labels = strcontains(local.csi_manifest_yaml, "HCLOUD_VOLUME_EXTRA_LABELS") && strcontains(
    local.csi_manifest_yaml, "cluster=${local.cluster_name}"
  )
}

# The label invariant is a MONEY guard (an unlabelled volume is unreclaimable and bills forever),
# so it must HARD-FAIL, not warn. OpenTofu `check` blocks only emit WARNINGS — they do not fail
# plan or apply — which makes them the wrong tool here: a silent label regression would sail
# through as a warning buried in runner logs. A `lifecycle.precondition` fails the plan outright.
resource "terraform_data" "csi_volume_label_guard" {
  input = local.hcloud_csi_version

  lifecycle {
    precondition {
      condition     = local.csi_has_volume_labels
      error_message = "CSI controller must set HCLOUD_VOLUME_EXTRA_LABELS with cluster=${local.cluster_name} (needs hcloud-csi chart in [2.15.0, 2.20.2]); without it, dynamically-provisioned pvc-* volumes carry no cluster label, cannot be reclaimed by the cluster-scoped teardown, and leak as billable resources."
    }
  }
}
