// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// hygCoreManifestsFileNames returns the sorted filenames of a GenerateManifests result.
func hygCoreManifestsFileNames(files map[string]string) []string {
	out := make([]string, 0, len(files))
	for name := range files {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// TestHygCoreManifestsSuffixNeverClobbersARealApp pins #2054: the `-<n>` de-duplication suffix used
// to be written without checking whether that filename was already claimed, so an app genuinely
// named "api-2" overwrote the second "api" (or vice versa) and three apps produced two files —
// one workload's manifest silently dropped from what WriteManifests commits.
func TestHygCoreManifestsSuffixNeverClobbersARealApp(t *testing.T) {
	apps := []App{
		{Name: "api", Image: "reg/a@sha256:aaa"},
		{Name: "API", Image: "reg/b@sha256:bbb"}, // dns1123 collapses this onto "api"
		{Name: "api-2", Image: "reg/c@sha256:ccc"},
	}

	// Precondition: the collision this guards against is real — the first two names normalize to
	// the same label, and the third is exactly the name the suffix would fabricate for the second.
	if dns1123(apps[0].Name) != dns1123(apps[1].Name) {
		t.Fatalf("precondition: %q and %q must normalize to the same label", apps[0].Name, apps[1].Name)
	}
	if dns1123(apps[2].Name) != dns1123(apps[1].Name)+"-2" {
		t.Fatalf("precondition: %q must be the name the -2 suffix fabricates", apps[2].Name)
	}

	files, err := GenerateManifests(apps)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("3 apps must produce 3 files, got %d: %v", len(files), hygCoreManifestsFileNames(files))
	}
	for _, digest := range []string{"aaa", "bbb", "ccc"} {
		found := false
		for _, doc := range files {
			if strings.Contains(doc, digest) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("image %s was dropped from the rendered manifests: %v", digest, hygCoreManifestsFileNames(files))
		}
	}
}

// TestHygCoreManifestsFileNamesAreOrderIndependent pins the other half of #2054's fix: apps are
// rendered in name order, so the set of filenames a project produces does not depend on the order
// the caller listed its services in. Probing for an unclaimed name without sorting would hand the
// same three apps a different filename set per input order.
func TestHygCoreManifestsFileNamesAreOrderIndependent(t *testing.T) {
	a := App{Name: "api", Image: "reg/a@sha256:aaa"}
	b := App{Name: "API", Image: "reg/b@sha256:bbb"}
	c := App{Name: "api-2", Image: "reg/c@sha256:ccc"}

	first, err := GenerateManifests([]App{a, b, c})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	second, err := GenerateManifests([]App{c, b, a})
	if err != nil {
		t.Fatalf("generate reversed: %v", err)
	}

	want := strings.Join(hygCoreManifestsFileNames(first), ",")
	got := strings.Join(hygCoreManifestsFileNames(second), ",")
	if want != got {
		t.Errorf("filename set depends on input order: %q vs %q", want, got)
	}
	if len(second) != 3 {
		t.Errorf("3 apps must produce 3 files in either order, got %d: %v", len(second), got)
	}
}

// TestHygCoreManifestsDNS1123LengthBudget pins #2056 at the boundary: a DNS-1123 label is at most
// 63 characters, and a truncation that lands on a hyphen must not leave a trailing "-" (also
// invalid). Mirrors the budget packages/core/imagebuild already applies.
func TestHygCoreManifestsDNS1123LengthBudget(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"exactly 63 is untouched", strings.Repeat("a", 63), strings.Repeat("a", 63)},
		{"64 truncates to 63", strings.Repeat("a", 64), strings.Repeat("a", 63)},
		{"a cut landing on a hyphen leaves none", strings.Repeat("a", 62) + "-bbb", strings.Repeat("a", 62)},
		{"short names are unchanged", "My_Service", "my-service"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dns1123(tc.in)
			if got != tc.want {
				t.Errorf("dns1123(%d chars) = %q (%d chars), want %q", len(tc.in), got, len(got), tc.want)
			}
			if len(got) > dnsLabelMaxLen {
				t.Errorf("result is %d chars, over the %d-char DNS-1123 label limit", len(got), dnsLabelMaxLen)
			}
			if strings.HasSuffix(got, "-") {
				t.Errorf("result %q ends in a hyphen, which is not a valid DNS-1123 label", got)
			}
		})
	}
}

// TestHygCoreManifestsDNS1123MaxTakesASmallerBudget covers the composed-name path of #2056: a
// caller that prepends a literal can subtract it from the budget so the FINAL name still fits.
func TestHygCoreManifestsDNS1123MaxTakesASmallerBudget(t *testing.T) {
	got := dns1123Max(strings.Repeat("a", 80), 10)
	if got != strings.Repeat("a", 10) {
		t.Errorf("dns1123Max(80 chars, 10) = %q (%d chars), want 10 a's", got, len(got))
	}
}

// TestHygCoreManifestsRenderedLabelFitsDNSLabel proves #2056 end to end: the normalized name is the
// value of app.kubernetes.io/name on the Deployment, its pod template and its selector, and console
// validation carries no maximum — so a 70-character service name used to render a manifest the API
// server rejects on every ArgoCD sync while the deploy reported success.
func TestHygCoreManifestsRenderedLabelFitsDNSLabel(t *testing.T) {
	const overlong = 70

	// Precondition: the name really is over the limit before normalization, so a renderer that
	// happened to emit no label at all could not pass this test by accident.
	if overlong <= dnsLabelMaxLen {
		t.Fatalf("precondition: the probe name must exceed %d chars", dnsLabelMaxLen)
	}

	out, err := RenderApp(App{Name: strings.Repeat("a", overlong), Image: "reg/x@sha256:aaa"})
	if err != nil {
		t.Fatalf("render: %v", err)
	}

	checked := 0
	dec := yaml.NewDecoder(strings.NewReader(out))
	for {
		var doc map[string]any
		if derr := dec.Decode(&doc); derr != nil {
			break
		}
		for _, label := range hygCoreManifestsNameLabels(doc) {
			checked++
			if len(label) > dnsLabelMaxLen {
				t.Errorf("app.kubernetes.io/name is %d chars (>%d) — the API server rejects it: %q", len(label), dnsLabelMaxLen, label)
			}
			if strings.HasSuffix(label, "-") {
				t.Errorf("app.kubernetes.io/name %q ends in a hyphen", label)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no app.kubernetes.io/name label found in the rendered manifests — the assertion would be vacuous")
	}
}

// hygCoreManifestsNameLabels collects every app.kubernetes.io/name value in a decoded manifest —
// object metadata, a Deployment's pod template metadata, and its selector.
func hygCoreManifestsNameLabels(doc map[string]any) []string {
	const key = "app.kubernetes.io/name"
	var out []string

	var walk func(node any)
	walk = func(node any) {
		m, ok := node.(map[string]any)
		if !ok {
			return
		}
		if v, ok := m[key].(string); ok {
			out = append(out, v)
		}
		for _, child := range m {
			walk(child)
		}
	}
	walk(doc)
	return out
}
