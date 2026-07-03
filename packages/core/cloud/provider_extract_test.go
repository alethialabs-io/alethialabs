// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
		{"alibaba coming soon", "alibaba", true, "coming soon"},
		{"digitalocean coming soon", "digitalocean", true, "coming soon"},
		{"hetzner coming soon", "hetzner", true, "coming soon"},
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
			name:    "wrong key only",
			outputs: map[string]interface{}{"cluster_endpoint": "https://nope"},
			want:    "",
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
