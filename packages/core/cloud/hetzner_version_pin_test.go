// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

// Hetzner never forwards cluster_version: Talos installs HetznerKubernetesVersion (#5366). These
// tests hold the gate that keeps a stored cluster_version from naming any other minor, and the
// coupling between the Go pin and every copy of it outside Go.

// TestHetznerValidateConfig_ClusterVersion covers the three outcomes the issue decided: unset is
// accepted, the pinned minor (bare or as the full patch) is accepted, and anything else is refused
// with a message that names the installed version and the fix.
func TestHetznerValidateConfig_ClusterVersion(t *testing.T) {
	p := &hetznerProvider{}
	pinnedMinor := k8sMinor(HetznerKubernetesVersion)

	for _, ok := range []string{"", "  ", pinnedMinor, HetznerKubernetesVersion, "v" + HetznerKubernetesVersion} {
		cfg := baseHetznerConfig()
		cfg.Cluster.ClusterVersion = ok
		if err := p.ValidateConfig(cfg); err != nil {
			t.Errorf("cluster_version %q refused, want accepted: %v", ok, err)
		}
	}

	for _, bad := range []string{"1.33", "1.34", "1.36", "1.35x", "latest"} {
		cfg := baseHetznerConfig()
		cfg.Cluster.ClusterVersion = bad
		err := p.ValidateConfig(cfg)
		if err == nil {
			t.Errorf("cluster_version %q accepted, want refused: Hetzner installs %s", bad, HetznerKubernetesVersion)
			continue
		}
		msg := err.Error()
		for _, want := range []string{"cluster_version", bad, HetznerKubernetesVersion, "Clear cluster_version"} {
			if !strings.Contains(msg, want) {
				t.Errorf("cluster_version %q: error %q does not name %q", bad, msg, want)
			}
		}
	}
}

// TestHetznerValidateConfig_ClusterVersionFollowsTheInstalledVersion: the gate compares against the
// version tofu actually receives. A provider_config pin moves the installed version, so it moves
// what the gate admits — the two read one helper, and this proves it.
func TestHetznerValidateConfig_ClusterVersionFollowsTheInstalledVersion(t *testing.T) {
	p := &hetznerProvider{}
	cfg := baseHetznerConfig()
	cfg.Cluster.ProviderConfig = map[string]any{"kubernetes_version": "1.34.10"}

	cfg.Cluster.ClusterVersion = "1.34"
	if err := p.ValidateConfig(cfg); err != nil {
		t.Errorf("1.34 with a provider_config pin of 1.34.10 refused: %v", err)
	}
	if got := p.ProviderTfvars(cfg)["kubernetes_version"]; got != "1.34.10" {
		t.Errorf("kubernetes_version = %v, want the provider_config pin 1.34.10", got)
	}

	cfg.Cluster.ClusterVersion = k8sMinor(HetznerKubernetesVersion)
	if err := p.ValidateConfig(cfg); err == nil || !strings.Contains(err.Error(), "1.34.10") {
		t.Errorf("default minor with a 1.34.10 pin: err = %v, want a refusal naming 1.34.10", err)
	}
}

// TestHetznerKubernetesPinMatchesTemplate holds HetznerKubernetesVersion equal to every copy of
// the pin outside Go: the template variable's default (the source), the cilium.tf render
// fallback, and the console's generated template-knobs manifest, which the inspector reads to show
// the pin. A pattern that does not match is a hard failure, never a skip.
func TestHetznerKubernetesPinMatchesTemplate(t *testing.T) {
	root := repoRootForCouplings(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping template scrape")
	}

	scrape := func(rel string, re *regexp.Regexp) string {
		t.Helper()
		m := re.FindStringSubmatch(readTemplateSource(t, root, rel))
		if m == nil {
			t.Fatalf("pattern %s not found in %s (format changed? re-anchor this coupling)", re, rel)
		}
		return m[1]
	}

	varsRel := "infra/templates/project/hetzner/variables.tf"
	if got := scrape(varsRel, regexp.MustCompile(
		`(?s)variable "kubernetes_version" \{[^}]*?default\s*=\s*"([^"]+)"`)); got != HetznerKubernetesVersion {
		t.Errorf("%s defaults kubernetes_version to %q, but cloud.HetznerKubernetesVersion is %q — change them in lockstep",
			varsRel, got, HetznerKubernetesVersion)
	}

	ciliumRel := "infra/templates/project/hetzner/cilium.tf"
	if got := scrape(ciliumRel, regexp.MustCompile(
		`render_kube_version\s*=\s*var\.kubernetes_version == "" \? "([^"]+)"`)); got != HetznerKubernetesVersion {
		t.Errorf("%s falls back to %q, but cloud.HetznerKubernetesVersion is %q", ciliumRel, got, HetznerKubernetesVersion)
	}

	knobsRel := "apps/console/lib/cloud-providers/generated/template-knobs.json"
	var manifest struct {
		Knobs []struct {
			Cloud   string `json:"cloud"`
			Name    string `json:"name"`
			Default any    `json:"default"`
		} `json:"knobs"`
	}
	if err := json.Unmarshal([]byte(readTemplateSource(t, root, knobsRel)), &manifest); err != nil {
		t.Fatalf("parse %s: %v", knobsRel, err)
	}
	found := false
	for _, k := range manifest.Knobs {
		if k.Cloud == "hetzner" && k.Name == "kubernetes_version" {
			found = true
			if k.Default != HetznerKubernetesVersion {
				t.Errorf("%s records the hetzner kubernetes_version default as %v, want %q — regenerate it",
					knobsRel, k.Default, HetznerKubernetesVersion)
			}
		}
	}
	if !found {
		t.Fatalf("%s has no hetzner kubernetes_version knob (re-anchor this coupling)", knobsRel)
	}

	// The default the provider emits is the same constant, not a second literal.
	if got := (&hetznerProvider{}).ProviderTfvars(baseHetznerConfig())["kubernetes_version"]; got != HetznerKubernetesVersion {
		t.Errorf("ProviderTfvars kubernetes_version = %v, want %q", got, HetznerKubernetesVersion)
	}
}
