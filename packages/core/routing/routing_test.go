// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package routing

import (
	"strings"
	"testing"
)

func TestExpand(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		params  map[string]string
		want    string
	}{
		{"no parameters", RouteCliLogin, nil, "/cli/login"},
		{"one", RouteOrg, map[string]string{"org": "acme"}, "/acme"},
		{"two", RouteOrgProject, map[string]string{"org": "acme", "project": "boutique"}, "/acme/boutique"},
		{"the ~ marker is a literal segment", RouteOrgJobs, map[string]string{"org": "acme"}, "/acme/~/jobs"},
		{"a mid-path parameter", RouteOrgJobsID, map[string]string{"org": "acme", "id": "j1"}, "/acme/~/jobs/j1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Expand(tc.pattern, tc.params)
			if err != nil || got != tc.want {
				t.Errorf("Expand(%q) = %q, %v; want %q", tc.pattern, got, err, tc.want)
			}
		})
	}
}

// Every refusal here is a URL that would otherwise be built and would go somewhere else — which
// is the failure this package exists to end, not a new one to introduce.
func TestExpand_Refusals(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		params  map[string]string
		says    string
	}{
		{"a missing parameter", RouteOrgProject, map[string]string{"org": "acme"}, "[project]"},
		{"an empty parameter", RouteOrgProject, map[string]string{"org": "acme", "project": ""}, "[project]"},
		{"a parameter the route does not take", RouteOrg, map[string]string{"org": "acme", "project": "x"}, "does not take project"},
		{"a catch-all", "/dashboard/[[...rest]]", map[string]string{"rest": "x"}, "catch-all"},
		{"a splat", "/x/[...rest]", map[string]string{"rest": "x"}, "catch-all"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Expand(tc.pattern, tc.params)
			if err == nil {
				t.Fatalf("Expand returned %q for %s", got, tc.name)
			}
			if !strings.Contains(err.Error(), tc.says) {
				t.Errorf("error %q does not say %q", err, tc.says)
			}
		})
	}
}

func TestBuilders(t *testing.T) {
	const origin = "https://alethialabs.io"
	cases := map[string]struct {
		got  func() (string, error)
		want string
	}{
		"org":     {func() (string, error) { return Org(origin, "acme") }, origin + "/acme"},
		"project": {func() (string, error) { return Project(origin, "acme", "boutique") }, origin + "/acme/boutique"},
		"jobs":    {func() (string, error) { return Jobs(origin, "acme") }, origin + "/acme/~/jobs"},
		"job":     {func() (string, error) { return Job(origin, "acme", "j1") }, origin + "/acme/~/jobs/j1"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := tc.got()
			if err != nil || got != tc.want {
				t.Errorf("= %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	// A trailing slash on the origin must not double up: the origin comes from a person's config.
	if got, _ := Org(origin+"/", "acme"); got != origin+"/acme" {
		t.Errorf("a trailing slash on the origin produced %q", got)
	}
	if _, err := Org(origin, ""); err == nil {
		t.Error("an empty org must be refused rather than linking to the origin root")
	}
	if _, err := URL(origin, RouteOrgProject, map[string]string{"org": "acme"}); err == nil {
		t.Error("URL must carry Expand's refusal")
	}
}

// The `/dashboard` link this package replaces was a legacy catch-all: `project get --open` opened
// the org root rather than the project, and nothing could tell. This is that regression, pinned.
func TestProjectLinkIsNotTheDashboard(t *testing.T) {
	got, err := Project("https://alethialabs.io", "acme", "boutique")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "/dashboard") {
		t.Errorf("the project link is still the legacy catch-all: %s", got)
	}
}

func TestProjectSlug(t *testing.T) {
	cases := map[string]string{
		"boutique":       "boutique",
		"Boutique":       "boutique",
		"My Shop":        "my-shop",
		"Bob's Project":  "bobs-project",
		"café":           "cafe",
		"  spaced  out ": "spaced-out",
	}
	for name, want := range cases {
		if got := ProjectSlug(name); got != want {
			t.Errorf("ProjectSlug(%q) = %q, want %q", name, got, want)
		}
	}
	// A name that slugs away entirely still yields a link rather than `/acme/` — the fallback is
	// the slugifier's own, and it 404s honestly instead of resolving to the org page.
	if got := ProjectSlug("!!!"); got == "" {
		t.Error("ProjectSlug returned an empty segment, which would link to the org page")
	}
}

// The generated table is the console's tree, so a route this package builds over must be IN it.
// Without this, a builder could name a constant that the generator no longer emits — which is a
// compile error — or a pattern nobody generates, which is not.
func TestRoutesTableIsWhatTheBuildersUse(t *testing.T) {
	if len(Routes) < 20 {
		t.Fatalf("the generated table has %d routes — that is a broken generation, not a small console", len(Routes))
	}
	inTable := map[string]bool{}
	for _, r := range Routes {
		inTable[r] = true
	}
	for _, used := range []string{RouteOrg, RouteOrgProject, RouteOrgJobs, RouteOrgJobsID} {
		if !inTable[used] {
			t.Errorf("%q is built over but is not in the generated table", used)
		}
	}
	// Every pattern must expand from its own parameters — a pattern nothing can fill is a
	// constant that would fail at run time rather than at build time.
	for _, r := range Routes {
		params := map[string]string{}
		for _, seg := range strings.Split(r, "/") {
			if strings.HasPrefix(seg, "[") {
				params[strings.TrimSuffix(strings.TrimPrefix(seg, "["), "]")] = "x"
			}
		}
		if _, err := Expand(r, params); err != nil {
			t.Errorf("Expand(%q): %v", r, err)
		}
	}
}
