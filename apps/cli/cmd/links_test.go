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
