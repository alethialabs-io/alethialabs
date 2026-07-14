// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strings"
	"testing"
)

// TestNewCloudProvider_ComingSoon covers the connectable-but-not-provisionable
// providers and the unsupported default — both error, with distinct messages.
func TestNewCloudProvider_ComingSoon(t *testing.T) {
	tests := []struct {
		name         string
		provider     string
		wantErr      bool
		wantContains string
	}{
		{"digitalocean coming soon", "digitalocean", true, "coming soon"},
		{"civo coming soon", "civo", true, "coming soon"},
		{"empty unsupported", "", true, "unsupported cloud provider"},
		{"garbage unsupported", "not-a-cloud", true, "unsupported cloud provider"},
		{"case sensitive unsupported", "AWS", true, "unsupported cloud provider"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := NewCloudProvider(tt.provider)
			if !tt.wantErr {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error for provider %q, got provider %v", tt.provider, p)
			}
			if p != nil {
				t.Errorf("expected nil provider on error, got %v", p)
			}
			if !strings.Contains(err.Error(), tt.wantContains) {
				t.Errorf("error %q does not contain %q", err.Error(), tt.wantContains)
			}
		})
	}
}

// TestNewCloudProvider_Hetzner covers the self-managed Talos-on-Hetzner provider,
// which is now provisionable (no longer "coming soon").
func TestNewCloudProvider_Hetzner(t *testing.T) {
	p, err := NewCloudProvider("hetzner")
	if err != nil {
		t.Fatalf("unexpected error for hetzner: %v", err)
	}
	if p == nil {
		t.Fatal("expected a provider for hetzner, got nil")
	}
	if p.Name() != "hetzner" {
		t.Errorf("Name() = %q, want %q", p.Name(), "hetzner")
	}
}

// TestNewCloudProvider_Alibaba covers the full managed Alibaba provider, now provisionable.
func TestNewCloudProvider_Alibaba(t *testing.T) {
	p, err := NewCloudProvider("alibaba")
	if err != nil {
		t.Fatalf("unexpected error for alibaba: %v", err)
	}
	if p == nil || p.Name() != "alibaba" {
		t.Fatalf("expected alibaba provider, got %v", p)
	}
}

// TestExtractClusterName_Malformed covers nil/empty maps and outputs whose
// shapes don't match either the nested {"value": string} or flat-string forms.
func TestExtractClusterName_Malformed(t *testing.T) {
	tests := []struct {
		name    string
		outputs map[string]interface{}
		want    string
	}{
		{"nil map", nil, ""},
		{"empty map", map[string]interface{}{}, ""},
		{
			name:    "nested value is non-string",
			outputs: map[string]interface{}{"eks_cluster_name": map[string]interface{}{"value": 42}},
			want:    "",
		},
		{
			name:    "nested map without value key",
			outputs: map[string]interface{}{"gke_cluster_name": map[string]interface{}{"other": "x"}},
			want:    "",
		},
		{
			name:    "value is a non-string non-map type",
			outputs: map[string]interface{}{"aks_cluster_name": 123},
			want:    "",
		},
		{
			name:    "nested empty value string",
			outputs: map[string]interface{}{"aks_cluster_name": map[string]interface{}{"value": ""}},
			want:    "",
		},
		{
			name:    "gke nested wins over aks flat when no eks",
			outputs: map[string]interface{}{"gke_cluster_name": map[string]interface{}{"value": "gke-x"}, "aks_cluster_name": "aks-y"},
			want:    "gke-x",
		},
		{
			// BYO-IaC generic fallback: a doc-following customer module names its output
			// `cluster_name`. It MUST be recognized, else the whole post-apply block
			// (kubeconfig/reachability/ArgoCD/add-ons) is silently skipped (FT-1).
			name:    "generic cluster_name recognized (BYO-IaC)",
			outputs: map[string]interface{}{"cluster_name": map[string]interface{}{"value": "byo-cluster"}},
			want:    "byo-cluster",
		},
		{
			name:    "flat generic cluster_name recognized (BYO-IaC)",
			outputs: map[string]interface{}{"cluster_name": "byo-flat"},
			want:    "byo-flat",
		},
		{
			// Provider-prefixed key must WIN when both are present so managed templates
			// are unaffected by the generic fallback.
			name:    "eks_cluster_name wins over generic cluster_name",
			outputs: map[string]interface{}{"eks_cluster_name": "eks-managed", "cluster_name": "generic-byo"},
			want:    "eks-managed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractClusterName(tt.outputs)
			if got != tt.want {
				t.Errorf("ExtractClusterName() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestExtract_GenericByoOutputs proves the end-to-end BYO-IaC contract: a module that
// emits ONLY the documented generic outputs (no provider-prefixed keys) yields a non-empty
// cluster name AND endpoint. Before FT-1 both returned "", so deploy.go skipped kubeconfig,
// reachability, ArgoCD and every add-on while still reporting success.
func TestExtract_GenericByoOutputs(t *testing.T) {
	outputs := map[string]interface{}{
		"cluster_name":     map[string]interface{}{"value": "byo-k8s"},
		"cluster_endpoint": map[string]interface{}{"value": "https://byo-k8s.example.com:6443"},
	}
	if got := ExtractClusterName(outputs); got != "byo-k8s" {
		t.Errorf("ExtractClusterName(generic) = %q, want %q", got, "byo-k8s")
	}
	if got := ExtractClusterEndpoint(outputs); got != "https://byo-k8s.example.com:6443" {
		t.Errorf("ExtractClusterEndpoint(generic) = %q, want %q", got, "https://byo-k8s.example.com:6443")
	}
}

// TestExtractClusterEndpoint_EdgeCases covers nested EKS, flat strings, priority
// ordering, and malformed shapes for the endpoint extractor.
func TestExtractClusterEndpoint_EdgeCases(t *testing.T) {
	tests := []struct {
		name    string
		outputs map[string]interface{}
		want    string
	}{
		{"nil map", nil, ""},
		{
			name:    "nested EKS value",
			outputs: map[string]interface{}{"eks_cluster_endpoint": map[string]interface{}{"value": "https://eks.example.com"}},
			want:    "https://eks.example.com",
		},
		{
			name:    "flat EKS string",
			outputs: map[string]interface{}{"eks_cluster_endpoint": "https://eks-flat.example.com"},
			want:    "https://eks-flat.example.com",
		},
		{
			name:    "EKS endpoint takes priority over GKE",
			outputs: map[string]interface{}{"eks_cluster_endpoint": "https://eks", "gke_cluster_endpoint": "https://gke"},
			want:    "https://eks",
		},
		{
			name:    "nested value non-string falls through to empty",
			outputs: map[string]interface{}{"aks_cluster_endpoint": map[string]interface{}{"value": true}},
			want:    "",
		},
		{
			// BYO-IaC generic fallback: a doc-following customer module emits the neutral
			// `cluster_endpoint` output. It MUST now be recognized (FT-1).
			name:    "generic cluster_endpoint recognized (BYO-IaC)",
			outputs: map[string]interface{}{"cluster_endpoint": "https://byo.example.com"},
			want:    "https://byo.example.com",
		},
		{
			name:    "nested generic cluster_endpoint recognized (BYO-IaC)",
			outputs: map[string]interface{}{"cluster_endpoint": map[string]interface{}{"value": "https://byo-nested.example.com"}},
			want:    "https://byo-nested.example.com",
		},
		{
			// Provider-prefixed endpoint must WIN over the generic fallback.
			name:    "eks_cluster_endpoint wins over generic cluster_endpoint",
			outputs: map[string]interface{}{"eks_cluster_endpoint": "https://eks", "cluster_endpoint": "https://generic"},
			want:    "https://eks",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractClusterEndpoint(tt.outputs)
			if got != tt.want {
				t.Errorf("ExtractClusterEndpoint() = %q, want %q", got, tt.want)
			}
		})
	}
}
