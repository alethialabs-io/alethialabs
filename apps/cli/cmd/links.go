// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/routing"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The CLI's console links, built over the console's own route tree (packages/core/routing, whose
// table is generated from `apps/console/app/(private)/**`).
//
// Before this file the CLI built exactly one deep link — `{origin}/dashboard` — a legacy catch-all
// that 307s to the org root. So `alethia project get boutique --open` did not open the project, and
// nothing could tell: the URL was a string literal in a Go file and the routes are directories in a
// Next.js app. `check:route-parity` is the other half; this is the half that uses it.
//
// # The org slug
//
// Every private route starts with `/[org]`, and the CLI learns the slug the same way it learns
// everything else about the active org: `alethia org switch` persists it, and `whoami` carries it.
// The config is consulted first because it costs no request; the fetch is the fallback for a
// machine that has authenticated but never switched.

// orgSlugFetcher is the one call resolveOrgSlug makes when the config has no slug.
type orgSlugFetcher interface {
	Whoami() (*api.WhoAmI, error)
}

// resolveOrgSlug returns the active organization's slug.
//
// A missing slug is an ERROR rather than an empty segment, and that is the whole point: an empty
// segment builds `{origin}//boutique`, a URL that resolves to something — the org root — and looks
// like it worked. The refusal names what to do about it.
func resolveOrgSlug(c orgSlugFetcher) (string, error) {
	if slug := types.LoadCliConfig().ActiveOrgSlug; slug != "" {
		return slug, nil
	}
	who, err := c.Whoami()
	if err != nil {
		return "", fmt.Errorf("resolve the active organization: %w", err)
	}
	if who == nil || who.ActiveOrg == nil || who.ActiveOrg.Slug == "" {
		// The personal scope has no organization, so it has no `/[org]` segment and no console
		// page under one. Naming `org switch` is the action, not a description of the problem.
		return "", fmt.Errorf("no active organization to build a console link for — run `alethia org switch` to choose one")
	}
	return who.ActiveOrg.Slug, nil
}

// projectLink is the console URL for a project, addressed by NAME.
//
// The name is slugified here because that is what the console's `[project]` segment resolves and
// the CLI's project wire carries the name. `routing.ProjectSlug` is the server's own rule, with the
// stated gap that a second project whose name slugs identically is suffixed server-side — such a
// link 404s rather than opening the wrong project.
func projectLink(c orgSlugFetcher, projectName string) (string, error) {
	slug, err := resolveOrgSlug(c)
	if err != nil {
		return "", err
	}
	return routing.Project(WebOrigin(), slug, routing.ProjectSlug(projectName))
}

// orgLink is the console URL for the active organization's overview.
func orgLink(c orgSlugFetcher) (string, error) {
	slug, err := resolveOrgSlug(c)
	if err != nil {
		return "", err
	}
	return routing.Org(WebOrigin(), slug)
}
