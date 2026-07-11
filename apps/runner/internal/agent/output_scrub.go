// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "strings"

// sensitiveOutputSubstrings marks a tofu output as a credential that must NOT be
// persisted into the job's execution_metadata (which lands in the console Postgres,
// readable by DB backups/replicas and cross-tenant support staff). These outputs are
// still used in-process by the deploy pipeline (ConfigureKubeconfig, ArgoCD bootstrap);
// only the copy we ship to the console is scrubbed.
//
// The list targets full kubeconfigs and raw client key material — e.g. Alibaba/Hetzner
// emit a `kubeconfig` (and Hetzner a `talosconfig`) sensitive output containing a
// cluster-admin client cert + key. Cluster endpoints and CA certs are public and kept.
var sensitiveOutputSubstrings = []string{
	"kubeconfig",
	"kube_config",
	"talosconfig",
	"client_key",
	"client_certificate",
	"private_key",
	"client_secret",
}

// isSensitiveOutputKey reports whether an output key names credential material that must
// be kept out of the persisted job metadata. Match is case-insensitive substring so
// prefixed/suffixed variants (e.g. `gke_kubeconfig`, `kube_config_raw`) are covered.
func isSensitiveOutputKey(key string) bool {
	lower := strings.ToLower(key)
	for _, s := range sensitiveOutputSubstrings {
		if strings.Contains(lower, s) {
			return true
		}
	}
	return false
}

// scrubSensitiveOutputs returns a shallow copy of the tofu outputs with credential-bearing
// keys removed, safe to persist into execution_metadata. The input map is not mutated (the
// deploy pipeline keeps using the full outputs in-process). Returns nil for a nil/empty input.
func scrubSensitiveOutputs(outputs map[string]any) map[string]any {
	if len(outputs) == 0 {
		return nil
	}
	scrubbed := make(map[string]any, len(outputs))
	for k, v := range outputs {
		if isSensitiveOutputKey(k) {
			continue
		}
		scrubbed[k] = v
	}
	return scrubbed
}
