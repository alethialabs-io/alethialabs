// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoRenderedApp is the slice of a rendered add-on Application these tests read.
type byoRenderedApp struct {
	Metadata struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Spec struct {
		Project string `yaml:"project"`
		Source  struct {
			RepoURL string `yaml:"repoURL"`
			Chart   string `yaml:"chart"`
			Path    string `yaml:"path"`
		} `yaml:"source"`
		Destination struct {
			Namespace string `yaml:"namespace"`
		} `yaml:"destination"`
		SyncPolicy struct {
			Automated *struct {
				Prune    bool `yaml:"prune"`
				SelfHeal bool `yaml:"selfHeal"`
			} `yaml:"automated"`
		} `yaml:"syncPolicy"`
	} `yaml:"spec"`
}

// renderByoApp renders a and decodes the result, failing the test on a render error.
func renderByoApp(t *testing.T, a types.AddOnInstall) byoRenderedApp {
	t.Helper()
	out, err := RenderAddOnApplication(a)
	if err != nil {
		t.Fatalf("render %s: %v", a.ID, err)
	}
	var app byoRenderedApp
	if err := yaml.Unmarshal([]byte(out), &app); err != nil {
		t.Fatalf("decode %s: %v\n%s", a.ID, err, out)
	}
	return app
}

// ociChart is an OCI-registry chart spec as the console resolves it; byo marks it as the customer's.
func ociChart(byo bool, project string) types.AddOnInstall {
	return types.AddOnInstall{
		ID: "payments", Mode: "managed", Source: "helm", Byo: byo, Project: project,
		ChartRepo: "oci://ghcr.io/acme", Chart: "payments", Version: "1.4.2", Namespace: "byo-payments",
	}
}

// TestIsByo — the marker makes an OCI chart BYO; a git source is BYO with or without it (snapshots
// written before the marker); a catalogue chart, OCI or not, is not.
func TestIsByo(t *testing.T) {
	for _, tc := range []struct {
		name string
		a    types.AddOnInstall
		want bool
	}{
		{"OCI BYO chart", ociChart(true, ""), true},
		{"git BYO chart, marked", types.AddOnInstall{Source: "git", Byo: true}, true},
		{"git BYO chart, from a snapshot before the marker", types.AddOnInstall{Source: "git"}, true},
		{"catalogue OCI chart", ociChart(false, ""), false},
		{"catalogue Helm chart", types.AddOnInstall{Source: "helm", ChartRepo: "https://charts.example.com"}, false},
		{"operator manifest", types.AddOnInstall{Source: "manifest"}, false},
	} {
		if got := tc.a.IsByo(); got != tc.want {
			t.Errorf("%s: IsByo() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestRenderAddOnApplication_OCIByoChartIsHardened: an OCI BYO chart renders as a Helm chart source
// (repoURL + chart, no path) under its byo-<slug> project, with the BYO sync policy — auto-sync, prune
// and self-heal off — not the catalogue's.
func TestRenderAddOnApplication_OCIByoChartIsHardened(t *testing.T) {
	app := renderByoApp(t, ociChart(true, "byo-acme"))
	if app.Spec.Project != "byo-acme" {
		t.Errorf("project = %q, want byo-acme", app.Spec.Project)
	}
	if app.Spec.Source.RepoURL != "oci://ghcr.io/acme" || app.Spec.Source.Chart != "payments" || app.Spec.Source.Path != "" {
		t.Errorf("source = %+v, want the OCI repo and chart with no path", app.Spec.Source)
	}
	if a := app.Spec.SyncPolicy.Automated; a == nil || a.Prune || a.SelfHeal {
		t.Errorf("automated = %+v, want auto-sync with prune and self-heal OFF", a)
	}
	if app.Metadata.Name != AddOnAppName("payments") {
		t.Errorf("name = %q: the Application must keep the name a catalogue-style render gave it, so a re-apply moves it in place", app.Metadata.Name)
	}
}

// TestRenderAddOnApplication_CatalogueOCIChartIsUnchanged: an OCI chart WITHOUT the marker is a
// catalogue chart. It keeps the "infra" project and the catalogue sync policy — the URL scheme is not
// a BYO signal.
func TestRenderAddOnApplication_CatalogueOCIChartIsUnchanged(t *testing.T) {
	app := renderByoApp(t, ociChart(false, ""))
	if app.Spec.Project != "infra" {
		t.Errorf("project = %q, want infra", app.Spec.Project)
	}
	if a := app.Spec.SyncPolicy.Automated; a == nil || !a.Prune || !a.SelfHeal {
		t.Errorf("automated = %+v, want prune and self-heal on", a)
	}
}

// TestRenderAddOnApplication_RefusesAByoChartWithoutItsHardenedProject: a BYO chart the runner did
// not pin is refused, never defaulted to "infra" — for an empty project, and for any project that is
// not a byo-<slug> one.
func TestRenderAddOnApplication_RefusesAByoChartWithoutItsHardenedProject(t *testing.T) {
	git := types.AddOnInstall{ID: "api", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/charts", Path: "charts/api", Version: "HEAD", Namespace: "byo-api"}
	for _, tc := range []struct {
		name string
		a    types.AddOnInstall
	}{
		{"OCI, empty project", ociChart(true, "")},
		{"OCI, infra", ociChart(true, "infra")},
		{"git, empty project", git},
	} {
		out, err := RenderAddOnApplication(tc.a)
		if err == nil {
			t.Errorf("%s: rendered instead of refusing:\n%s", tc.name, out)
			continue
		}
		if !strings.Contains(err.Error(), "refusing to render BYO chart") || !strings.Contains(err.Error(), tc.a.ID) {
			t.Errorf("%s: the refusal must name the chart, got %v", tc.name, err)
		}
	}
	// The same chart, pinned, renders — so the refusal is about the project and nothing else.
	git.Project = "byo-acme"
	if _, err := RenderAddOnApplication(git); err != nil {
		t.Errorf("a pinned git BYO chart must render: %v", err)
	}
}

// byoChartNamespaceCases is the table apps/console/tests/lib/validations/byo-charts-namespace.test.ts
// repeats for the console's byoChartNamespace, so the form's default and the runner's move agree.
// The hashed values are literals on purpose: both sides must produce exactly these strings.
var byoChartNamespaceCases = []struct{ id, want string }{
	{"payments", "byo-payments"},
	{"my-chart", "byo-my-chart"},
	// A 57-character id — the longest the console derives for a NEW chart — fits with its prefix.
	{strings.Repeat("a", 57), "byo-" + strings.Repeat("a", 57)},
	// 59 characters is the longest that fits whole.
	{strings.Repeat("a", 59), "byo-" + strings.Repeat("a", 59)},
	// Longer, stored legacy ids are cut and end in a hash of the WHOLE id, so two that share a
	// prefix still get two namespaces.
	{strings.Repeat("b", 58) + "-cdef", "byo-" + strings.Repeat("b", 50) + "-1f994818"},
	{strings.Repeat("b", 58) + "-zzzz", "byo-" + strings.Repeat("b", 50) + "-646f1ab0"},
	{strings.Repeat("c", 70), "byo-" + strings.Repeat("c", 50) + "-6335c5d7"},
}

// TestByoChartNamespace pins the default namespace derivation, that every result is a namespace a
// BYO chart may use, and that no two ids in the table share one.
func TestByoChartNamespace(t *testing.T) {
	seen := map[string]string{}
	for _, tc := range byoChartNamespaceCases {
		got := ByoChartNamespace(tc.id)
		if got != tc.want {
			t.Errorf("ByoChartNamespace(%q) = %q, want %q", tc.id, got, tc.want)
		}
		if err := ValidateByoNamespace(got); err != nil {
			t.Errorf("ByoChartNamespace(%q) = %q, which that chart may not use: %v", tc.id, got, err)
		}
		if other, dup := seen[got]; dup {
			t.Errorf("ids %q and %q both derive %q", other, tc.id, got)
		}
		seen[got] = tc.id
	}
}

// TestByoReserved_DefaultIsReservedForThePlatformsWorkloads: "default" — where the platform runs its
// first-class workloads — is refused, and it is the platformWorkloads group's only name.
func TestByoReserved_DefaultIsReservedForThePlatformsWorkloads(t *testing.T) {
	err := ValidateByoNamespace(ByoLegacyDefaultNamespace)
	if err == nil || !strings.Contains(err.Error(), "reserved for the platform") || !strings.Contains(err.Error(), "workloads") {
		t.Fatalf("%q must be refused as the platform's workload namespace, got %v", ByoLegacyDefaultNamespace, err)
	}
	if got := byoReservedGroup(t, "platformWorkloads"); !reflect.DeepEqual(got, []string{ByoLegacyDefaultNamespace}) {
		t.Errorf("platformWorkloads = %v, want exactly [%q]", got, ByoLegacyDefaultNamespace)
	}
}
