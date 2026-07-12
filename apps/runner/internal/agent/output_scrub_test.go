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
		// Generated credential VALUES (the AWS P1 leak) — plaintext, must be scrubbed.
		"custom_secret_values":    map[string]any{"db-pass": "s3cr3t"},
		"generated_secret_values": map[string]any{"token": "t0ken"},
		// Non-secret handles — carry no plaintext, must survive (guards vs. over-broad "secret").
		"custom_secret_arns":     map[string]any{"db-pass": "arn:..."},
		"custom_secret_names":    map[string]any{"db-pass": "prod/db-pass"},
		"custom_secret_versions": map[string]any{"db-pass": "AWSCURRENT"},
	}
	out := scrubSensitiveOutputs(in)

	// Credential-bearing keys must be gone.
	for _, k := range []string{"kubeconfig", "talosconfig", "kube_config_raw", "gke_kubeconfig", "admin_client_key", "custom_secret_values", "generated_secret_values"} {
		if _, ok := out[k]; ok {
			t.Errorf("expected sensitive key %q to be scrubbed, but it was present", k)
		}
	}
	// Non-secret keys (endpoint, CA, name, secret handles) must be kept.
	for _, k := range []string{"eks_cluster_endpoint", "gke_cluster_ca_certificate", "cluster_name", "custom_secret_arns", "custom_secret_names", "custom_secret_versions"} {
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
		"custom_secret_values":       true,
		"generated_secret_values":    true,
		"db_password":                true,
		"admin_token":                true,
		"aws_access_key":             true,
		"aws_secret_key":             true,
		"eks_cluster_endpoint":       false,
		"gke_cluster_ca_certificate": false,
		"cluster_name":               false,
		"vpc_id":                     false,
		// Non-secret secret-handle outputs must NOT match (no bare "secret" substring).
		"custom_secret_arns":                false,
		"custom_secret_names":               false,
		"custom_secret_versions":            false,
		"rds_master_credentials_secret_arn": false,
		"external_secrets_client_id":        false,
	}
	for key, want := range cases {
		if got := isSensitiveOutputKey(key); got != want {
			t.Errorf("isSensitiveOutputKey(%q) = %v, want %v", key, got, want)
		}
	}
}
