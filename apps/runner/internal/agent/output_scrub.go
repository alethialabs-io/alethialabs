// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"strings"
)

// sensitiveOutputSubstrings marks a tofu output as a credential that must NOT be
// persisted into the job's execution_metadata (which lands in the console Postgres,
// readable by DB backups/replicas and cross-tenant support staff). These outputs are
// still used in-process by the deploy pipeline (ConfigureKubeconfig, ArgoCD bootstrap);
// only the copy we ship to the console is scrubbed.
//
// The list targets full kubeconfigs and raw client key material — e.g. Alibaba/Hetzner
// emit a `kubeconfig` (and Hetzner a `talosconfig`) sensitive output containing a
// cluster-admin client cert + key — plus generated credential VALUES: the AWS
// awssm-passgen module re-exports plaintext generated secrets as `custom_secret_values`,
// and any `*_secret_value(s)` / `password` / `_token` / `access_key` / `secret_key`
// output carries raw secret material. Cluster endpoints and CA certs are public and kept.
//
// Deliberately NOT included: a bare "secret" substring — the console legitimately shows the
// non-secret handles `custom_secret_arns` / `custom_secret_names` / `custom_secret_versions`
// and `rds_master_credentials_secret_arn`, none of which carry plaintext. Only value-bearing
// keys are dropped, so those survive.
var sensitiveOutputSubstrings = []string{
	"kubeconfig",
	"kube_config",
	"talosconfig",
	"client_key",
	"client_certificate",
	"private_key",
	"client_secret",
	// value-bearing generated credentials (e.g. AWS custom_secret_values, *_secret_values)
	"secret_value", // catches custom_secret_values / *_secret_value(s)
	"secret_key",
	"access_key",
	"password",
	"_token",
	// Rendered manifests carry embedded credentials: the Hetzner `bootstrap_manifests` output
	// (a sensitive=true join of the hcloud Secret + CNI/CCM/CSI YAML) embeds the hcloud API
	// token as base64(var.hcloud_token) — base64 is encoding, not encryption. The runner
	// consumes it in-process (applyn) and never needs it in the persisted metadata, so drop it.
	"manifest", // catches bootstrap_manifests / *_manifests
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

// scrubMetadataTree is the whole-blob denylist backstop: it walks the FULLY-assembled
// execution_metadata map (not just result.Outputs) and deletes any entry whose key names
// credential material (isSensitiveOutputKey), recursing into nested map[string]any / []any so
// a secret nested anywhere is caught. It is defense-in-depth for buildDeployMetadata — even if
// a future change reintroduces a top-level secret (e.g. the ArgoCD admin password) or a new
// tofu output shape carries one, nothing secret-bearing crosses into the console Postgres.
//
// It mutates m in place and returns the dotted paths dropped (for a warning log; a non-empty
// result signals a regression the backstop caught). Idempotent over an already-scrubbed
// outputs map, and it only descends into dynamic maps/slices — typed struct values the runner
// assembles (verify report, addon status, …) carry no plaintext credentials and are left as-is.
func scrubMetadataTree(m map[string]any) []string {
	var dropped []string
	scrubMetadataMap(m, "", &dropped)
	return dropped
}

// scrubMetadataMap removes denylisted keys from one map level and recurses into nested
// maps/slices. `prefix` is the dotted path to `m` for reporting; `dropped` accumulates hits.
func scrubMetadataMap(m map[string]any, prefix string, dropped *[]string) {
	for k, v := range m {
		path := k
		if prefix != "" {
			path = prefix + "." + k
		}
		if isSensitiveOutputKey(k) {
			delete(m, k)
			*dropped = append(*dropped, path)
			continue
		}
		switch child := v.(type) {
		case map[string]any:
			scrubMetadataMap(child, path, dropped)
		case []any:
			scrubMetadataSlice(child, path, dropped)
		}
	}
}

// scrubMetadataSlice recurses into a slice's map/slice elements (scalars carry no key to match).
func scrubMetadataSlice(s []any, prefix string, dropped *[]string) {
	for i, v := range s {
		switch child := v.(type) {
		case map[string]any:
			scrubMetadataMap(child, fmt.Sprintf("%s[%d]", prefix, i), dropped)
		case []any:
			scrubMetadataSlice(child, fmt.Sprintf("%s[%d]", prefix, i), dropped)
		}
	}
}
