// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The defect #2234 describes, at the level it actually bites: not "two files are written" (#2054
// fixed that) but "two files name ONE Kubernetes object". Proven by rendering, not by reading.
func TestGenerateManifests_CollidingNamesRenderOneObject(t *testing.T) {
	// Guard the premise first. If dns1123 ever stopped collapsing these, the assertion below would
	// pass for the wrong reason and this test would quietly stop testing anything.
	if dns1123("api") != dns1123("API") {
		t.Fatalf("premise broken: %q and %q no longer collapse — this test is vacuous", "api", "API")
	}

	out, err := GenerateManifests([]App{
		{Name: dns1123("api"), Namespace: "ns", Image: "img:1", Port: 80},
		{Name: dns1123("API"), Namespace: "ns", Image: "img:2", Port: 80},
	})
	if err != nil {
		t.Fatalf("GenerateManifests: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("want 2 files (that is #2054's fix), got %d", len(out))
	}
	// Both files name the same object. This is the residual #2054 exposed and #2234 is about.
	names := map[string]int{}
	for _, y := range out {
		for _, line := range strings.Split(y, "\n") {
			if s := strings.TrimSpace(line); strings.HasPrefix(s, "name: ") {
				names[strings.TrimPrefix(s, "name: ")]++
			}
		}
	}
	if len(names) != 1 {
		t.Fatalf("expected both files to render ONE object name (the defect), got %v", names)
	}
}

// The fix: FromServices refuses to render either, and says so. This FAILS on dev, where both are
// rendered and nothing lands in `skipped`.
func TestFromServices_ReportsCollisionAndRendersNeither(t *testing.T) {
	svcs := []types.ProjectServiceConfig{
		{Name: "api", ResolvedImage: "img:1"},
		{Name: "API", ResolvedImage: "img:2"},
		{Name: "web", ResolvedImage: "img:3"},
	}
	apps, skipped, _ := FromServices(svcs, Options{Namespace: "ns"})

	if len(apps) != 1 || apps[0].Name != "web" {
		got := []string{}
		for _, a := range apps {
			got = append(got, a.Name)
		}
		t.Fatalf("only the non-colliding service may render; got %v", got)
	}
	joined := strings.Join(skipped, "\n")
	for _, want := range []string{`"api"`, `"API"`, "normalize"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("skipped must name the collision and both services (missing %q); got:\n%s", want, joined)
		}
	}
}

// Truncation is the third way two names collapse, and the one a user is least likely to spot.
func TestNameCollisions_TruncationAndPunctuation(t *testing.T) {
	long := strings.Repeat("a", dnsLabelMaxLen)
	cases := []struct {
		name  string
		in    []string
		want  int
		label string
	}{
		{"case", []string{"api", "API"}, 1, "api"},
		{"punctuation", []string{"my.svc", "my-svc", "my_svc"}, 1, "my-svc"},
		{"truncation", []string{long + "-one", long + "-two"}, 1, long},
		{"distinct", []string{"api", "web", "worker"}, 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NameCollisions(tc.in)
			if len(got) != tc.want {
				t.Fatalf("want %d collision group(s), got %d: %+v", tc.want, len(got), got)
			}
			if tc.want > 0 && got[0].Label != tc.label {
				t.Fatalf("want label %q, got %q", tc.label, got[0].Label)
			}
		})
	}
}
