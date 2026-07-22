// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"strings"
	"testing"
)

// TestGetModulePath asserts that a resolved provider exposes the exact
// module_path declared in catalog.json for each known (category, slug).
func TestGetModulePath(t *testing.T) {
	tests := []struct {
		name     string
		category string
		slug     string
		wantPath string
	}{
		{"cloudflare dns", "dns", "cloudflare", "categories/dns/cloudflare"},
		{"vault secrets", "secrets", "vault", "categories/secrets/vault"},
		// registry providers are runner-seeded (a dockerconfigjson imagePullSecret applied
		// post-apply), so they carry NO tofu module → empty module_path.
		{"dockerhub registry", "registry", "dockerhub", ""},
		{"generic-cr registry", "registry", "generic-cr", ""},
		{"ghcr registry", "registry", "ghcr", ""},
		{"ghcr-enterprise registry", "registry", "ghcr-enterprise", ""},
		{"gitlab-cr registry", "registry", "gitlab-cr", ""},
		{"quay registry", "registry", "quay", ""},
		{"harbor registry", "registry", "harbor", ""},
		{"docr registry", "registry", "docr", ""},
		{"scaleway-cr registry", "registry", "scaleway-cr", ""},
		{"ecr-xacct registry", "registry", "ecr-xacct", ""},
		{"gar-xacct registry", "registry", "gar-xacct", ""},
		{"acr-xacct registry", "registry", "acr-xacct", ""},
		{"datadog observability", "observability", "datadog", "categories/observability/datadog"},
		{"grafana observability", "observability", "grafana", "categories/observability/grafana"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Get(tt.category, tt.slug)
			if err != nil {
				t.Fatalf("Get(%q, %q) unexpected error: %v", tt.category, tt.slug, err)
			}
			if got := p.ModulePath(); got != tt.wantPath {
				t.Errorf("ModulePath() = %q, want %q", got, tt.wantPath)
			}
		})
	}
}

// TestGetErrors covers Get's "unknown connector provider" failure mode across
// missing/empty inputs. Note: the catalog's cloud + git entries live under the
// `builtin` array, which Go ignores (only the `providers` array is loaded into
// metaIndex), so e.g. Get("cloud","aws") is correctly unknown to the category
// registry — this asserts builtin connectors are excluded from Go composition.
// (The "no registered behavior" branch is unreachable with real catalog data,
// since every `providers` row has a registered impl; it is not tested here to
// avoid faking the registry.)
func TestGetErrors(t *testing.T) {
	tests := []struct {
		name       string
		category   string
		slug       string
		wantSubstr string
	}{
		{"unknown slug", "dns", "route53again", "unknown connector provider"},
		{"wrong category for known slug", "registry", "cloudflare", "unknown connector provider"},
		{"empty slug", "dns", "", "unknown connector provider"},
		{"empty category", "", "cloudflare", "unknown connector provider"},
		{"both empty", "", "", "unknown connector provider"},
		{"builtin cloud excluded from go registry", "cloud", "aws", "unknown connector provider"},
		{"builtin git excluded from go registry", "git", "github", "unknown connector provider"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Get(tt.category, tt.slug)
			if err == nil {
				t.Fatalf("Get(%q, %q) = %+v, want error", tt.category, tt.slug, p)
			}
			if p != nil {
				t.Errorf("Get(%q, %q) returned non-nil provider %+v on error", tt.category, tt.slug, p)
			}
			if !strings.Contains(err.Error(), tt.wantSubstr) {
				t.Errorf("Get(%q, %q) error = %q, want substring %q", tt.category, tt.slug, err.Error(), tt.wantSubstr)
			}
		})
	}
}

// TestIsPluggableEdgeCases extends the basic coverage with case-sensitivity and
// whitespace inputs. IsPluggable treats ONLY the exact strings "" and "native"
// as non-pluggable; anything else (including "Native" or " native ") selects a
// pluggable backend.
func TestIsPluggableEdgeCases(t *testing.T) {
	tests := []struct {
		name string
		slug string
		want bool
	}{
		{"empty", "", false},
		{"exact native", "native", false},
		{"capitalized Native is pluggable", "Native", true},
		{"uppercase NATIVE is pluggable", "NATIVE", true},
		{"padded native is pluggable", " native ", true},
		{"whitespace only is pluggable", " ", true},
		{"cloudflare", "cloudflare", true},
		{"vault", "vault", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsPluggable(tt.slug); got != tt.want {
				t.Errorf("IsPluggable(%q) = %v, want %v", tt.slug, got, tt.want)
			}
		})
	}
}
