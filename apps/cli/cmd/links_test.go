// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// linkFake answers Whoami and records whether it was asked at all — the config path must cost no
// request, and "it worked" is not evidence of that.
type linkFake struct {
	who    *api.WhoAmI
	err    error
	called int
}

func (f *linkFake) Whoami() (*api.WhoAmI, error) {
	f.called++
	return f.who, f.err
}

func whoWithSlug(slug string) *api.WhoAmI {
	w := &api.WhoAmI{}
	if slug != "" {
		w.ActiveOrg = &api.OrgSummary{ID: "o1", Name: "Acme", Slug: slug}
	}
	return w
}

func TestResolveOrgSlug_PrefersTheConfigAndCostsNoRequest(t *testing.T) {
	isolatedHome(t)
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}
	f := &linkFake{who: whoWithSlug("other")}
	got, err := resolveOrgSlug(f)
	if err != nil || got != "acme" {
		t.Errorf("resolveOrgSlug = %q, %v; want the config's slug", got, err)
	}
	if f.called != 0 {
		t.Errorf("the config path made %d request(s) — it must cost none", f.called)
	}
}

func TestResolveOrgSlug_FallsBackToWhoami(t *testing.T) {
	isolatedHome(t)
	f := &linkFake{who: whoWithSlug("acme")}
	got, err := resolveOrgSlug(f)
	if err != nil || got != "acme" {
		t.Errorf("resolveOrgSlug = %q, %v; want acme from whoami", got, err)
	}
	if f.called != 1 {
		t.Errorf("whoami was called %d times", f.called)
	}
}

// An unresolvable org is an ERROR, never an empty segment: `{origin}//boutique` resolves to the
// org root and reads as a working link.
func TestResolveOrgSlug_RefusesRatherThanBuildingAnEmptySegment(t *testing.T) {
	isolatedHome(t)
	for name, f := range map[string]*linkFake{
		"whoami fails":        {err: errBoom},
		"no active org":       {who: whoWithSlug("")},
		"a nil whoami":        {who: nil},
		"an org with no slug": {who: &api.WhoAmI{ActiveOrg: &api.OrgSummary{ID: "o1"}}},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := resolveOrgSlug(f)
			if err == nil {
				t.Fatalf("resolveOrgSlug returned %q", got)
			}
			if got != "" {
				t.Errorf("a refusal still produced a slug: %q", got)
			}
		})
	}
	// The message names the action, because "no active organization" is not one.
	if _, err := resolveOrgSlug(&linkFake{who: whoWithSlug("")}); !strings.Contains(err.Error(), "org switch") {
		t.Errorf("the refusal does not name what to do about it: %v", err)
	}
}

func TestProjectAndOrgLinks(t *testing.T) {
	isolatedHome(t)
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://alethialabs.io")
	f := &linkFake{}
	got, err := projectLink(f, "My Shop")
	if err != nil || got != "https://alethialabs.io/acme/my-shop" {
		t.Errorf("projectLink = %q, %v — the name is slugified the way the console's [project] segment resolves", got, err)
	}
	if got, err := orgLink(f); err != nil || got != "https://alethialabs.io/acme" {
		t.Errorf("orgLink = %q, %v", got, err)
	}
	// Both carry the refusal rather than linking somewhere plausible.
	isolatedHome(t)
	broken := &linkFake{err: errBoom}
	if _, err := projectLink(broken, "shop"); err == nil {
		t.Error("projectLink swallowed an unresolvable org")
	}
	if _, err := orgLink(broken); err == nil {
		t.Error("orgLink swallowed an unresolvable org")
	}
}

// The config's slug describes the org the CLI last SWITCHED to. When `--org` or a service token
// scopes THIS invocation somewhere else, that slug names a different tenant than the command read
// from — so the fast path must be skipped and whoami, which answers under the same headers every
// other request carries, must be the source.
func TestResolveOrgSlug_SkipsTheConfigWhenScopedElsewhere(t *testing.T) {
	for name, scope := range map[string]func(t *testing.T){
		"--org names another org": func(t *testing.T) {
			api.SetOrgOverride("o2")
			t.Cleanup(func() { api.SetOrgOverride("") })
		},
		"a service token is in use": func(t *testing.T) { t.Setenv(ServiceTokenEnv, "alethia_sat_x") },
	} {
		t.Run(name, func(t *testing.T) {
			isolatedHome(t)
			if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgSlug: "acme"}); err != nil {
				t.Fatal(err)
			}
			scope(t)

			f := &linkFake{who: whoWithSlug("boutique")}
			got, err := resolveOrgSlug(f)
			if err != nil {
				t.Fatalf("resolveOrgSlug: %v", err)
			}
			if got == "acme" {
				t.Fatal("the link named the CONFIG's org, not the one this invocation acted in — " +
					"that URL opens another tenant's page, or 404s, and reads as if it worked")
			}
			if got != "boutique" {
				t.Errorf("resolveOrgSlug = %q, want boutique (the scope whoami answered under)", got)
			}
			if f.called != 1 {
				t.Errorf("whoami was called %d times; the config cannot answer when the scope is elsewhere", f.called)
			}
		})
	}
}

// A scope that resolves to no organization is refused rather than quietly falling back to the
// config — that fallback would build the link into the very tenant the override said not to use.
func TestResolveOrgSlug_RefusesWhenAnOverriddenScopeHasNoOrg(t *testing.T) {
	isolatedHome(t)
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}
	api.SetOrgOverride("o2")
	t.Cleanup(func() { api.SetOrgOverride("") })

	got, err := resolveOrgSlug(&linkFake{who: whoWithSlug("")})
	if err == nil {
		t.Fatalf("resolveOrgSlug returned %q for a scope with no organization", got)
	}
	if got == "acme" {
		t.Fatal("the refusal leaked the config's slug — the tenant the override excluded")
	}
	if !strings.Contains(err.Error(), "--org") {
		t.Errorf("the refusal does not name the scope to check: %v", err)
	}
}

// `--project` takes a NAME or an ID, as every other --project in this CLI does. An id must be
// resolved: it is already `[a-z0-9-]`, so it survives ProjectSlug untouched and builds a URL that
// reads as a link and 404s, because the console resolves `[project]` by slug and never by id.
func TestResolveProjectName_ResolvesAnIDAndPassesANameThrough(t *testing.T) {
	const id = "8f3c1d2e-4b5a-6c7d-8e9f-0a1b2c3d4e5f"
	lister := projFakeLister{configs: []types.ConfigurationSummary{
		{ID: id, ProjectName: "My Shop"},
		{ID: "p2", ProjectName: "web"},
	}}

	got, err := resolveProjectName(lister, id)
	if err != nil || got != "My Shop" {
		t.Errorf("resolveProjectName(id) = %q, %v; want the project's name", got, err)
	}

	// A name costs no request and is returned untouched — slugifying is projectLink's job.
	noRequests := projFakeLister{err: errBoom}
	if got, err := resolveProjectName(noRequests, "My Shop"); err != nil || got != "My Shop" {
		t.Errorf("resolveProjectName(name) = %q, %v; a name must not be looked up", got, err)
	}

	// An id nobody has is a refusal, not a slugified guess.
	unknown := "11111111-2222-3333-4444-555555555555"
	if got, err := resolveProjectName(lister, unknown); err == nil {
		t.Errorf("resolveProjectName(unknown id) = %q with no error — that URL 404s and reads as working", got)
	} else if !strings.Contains(err.Error(), "web") {
		t.Errorf("the refusal does not offer the projects that do exist: %v", err)
	}
}
