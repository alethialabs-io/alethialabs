# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Invariants asserted so a broken cluster handle fails loudly rather than silently
# producing empty outputs the runner would then try (and fail) to use.

# The cluster name the runner keys on must be non-empty (ExtractClusterName returning
# "" would silently SKIP the whole post-apply spine — the exact vacuous-pass this
# keystone exists to defeat).
check "cluster_name_present" {
  assert {
    condition     = length(trimspace(local.cluster_name)) > 0
    error_message = "talos_cluster_name is empty — the runner's post-apply spine would be silently skipped."
  }
}

# The emitted endpoint must be a real https URL (the kind API server), not a blank.
check "cluster_endpoint_is_https" {
  assert {
    condition     = can(regex("^https://", kind_cluster.this.endpoint))
    error_message = "kind cluster endpoint is not an https URL — the cluster is not reachable."
  }
}

# A non-empty kubeconfig is what ConfigureKubeconfig writes; empty means unreachable.
check "kubeconfig_present" {
  assert {
    condition     = length(kind_cluster.this.kubeconfig) > 0
    error_message = "kind cluster produced an empty kubeconfig — the cluster is unreachable."
  }
}
