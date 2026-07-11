// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "testing"

func TestScrubSensitiveOutputs(t *testing.T) {
	in := map[string]any{
		"eks_cluster_endpoint":       "https://abc.eks.amazonaws.com",
		"gke_cluster_ca_certificate": "LS0tLS1CRUdJTi...",
		"cluster_name":               "prod-eks",
		"kubeconfig":                 "apiVersion: v1\nkind: Config\n...client-key-data...",
		"talosconfig":                "context: ...",
		"kube_config_raw":            "apiVersion: v1...",
		"gke_kubeconfig":             "apiVersion: v1...",
		"admin_client_key":           "-----BEGIN PRIVATE KEY-----",
	}
	out := scrubSensitiveOutputs(in)

	// Credential-bearing keys must be gone.
	for _, k := range []string{"kubeconfig", "talosconfig", "kube_config_raw", "gke_kubeconfig", "admin_client_key"} {
		if _, ok := out[k]; ok {
			t.Errorf("expected sensitive key %q to be scrubbed, but it was present", k)
		}
	}
	// Non-secret keys (endpoint, CA, name) must be kept.
	for _, k := range []string{"eks_cluster_endpoint", "gke_cluster_ca_certificate", "cluster_name"} {
		if _, ok := out[k]; !ok {
			t.Errorf("expected non-secret key %q to be kept, but it was scrubbed", k)
		}
	}
	// The input map must not be mutated.
	if _, ok := in["kubeconfig"]; !ok {
		t.Error("input map was mutated: kubeconfig removed from source")
	}
}

func TestScrubSensitiveOutputs_Empty(t *testing.T) {
	if got := scrubSensitiveOutputs(nil); got != nil {
		t.Errorf("nil input should return nil, got %v", got)
	}
	if got := scrubSensitiveOutputs(map[string]any{}); got != nil {
		t.Errorf("empty input should return nil, got %v", got)
	}
}

func TestIsSensitiveOutputKey(t *testing.T) {
	cases := map[string]bool{
		"kubeconfig":                 true,
		"KubeConfig":                 true,
		"kube_config_raw":            true,
		"talosconfig":                true,
		"client_key":                 true,
		"client_certificate":         true,
		"private_key":                true,
		"client_secret":              true,
		"eks_cluster_endpoint":       false,
		"gke_cluster_ca_certificate": false,
		"cluster_name":               false,
		"vpc_id":                     false,
	}
	for key, want := range cases {
		if got := isSensitiveOutputKey(key); got != want {
			t.Errorf("isSensitiveOutputKey(%q) = %v, want %v", key, got, want)
		}
	}
}
