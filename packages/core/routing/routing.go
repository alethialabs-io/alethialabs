// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package routing builds console URLs for the CLI from the console's OWN route tree.
//
// # Why this exists
//
// The CLI used to build one deep link: `{origin}/dashboard`, a legacy catch-all that 307s to the
// org root. `alethia project get boutique --open` therefore did not open the project, and nothing
// could notice, because the URL was a string literal in a Go file and the route tree is a set of
// directories in a Next.js app.
//
// routes_gen.go is GENERATED from that tree (scripts/lib/console-routes.mjs, the same manifest the
// conformance guards read) by apps/console/scripts/gen-go-routes.ts. A route the console renames or
// removes disappears from the constants, and every builder over it stops compiling — which is the
// whole point: a route rename fails the build instead of silently breaking the CLI. The CI gate
// regenerates the file and diffs it; `pnpm check:route-parity` does the same locally.
//
// Direction of authority: the console owns its routes, so TS generates and Go consumes.
package routing

import (
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
)

// Expand fills a route pattern's `[param]` segments and returns the path.
//
// It refuses a missing parameter, a parameter the pattern does not take, an empty value, and a
// catch-all pattern (`[[...rest]]`) — each of those would render as a plausible URL that goes
// somewhere else. The `~` segment is the console's org-scoped marker and is kept verbatim.
func Expand(pattern string, params map[string]string) (string, error) {
	if strings.Contains(pattern, "[...") || strings.Contains(pattern, "[[") {
		return "", fmt.Errorf("routing: %s is a catch-all route and has no single URL", pattern)
	}
	used := map[string]bool{}
	segments := strings.Split(strings.TrimPrefix(pattern, "/"), "/")
	out := make([]string, 0, len(segments))
	for _, seg := range segments {
		if !strings.HasPrefix(seg, "[") {
			out = append(out, seg)
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(seg, "["), "]")
		value, ok := params[name]
		if !ok || value == "" {
			return "", fmt.Errorf("routing: %s needs a value for [%s]", pattern, name)
		}
		used[name] = true
		out = append(out, value)
	}
	var extra []string
	for name := range params {
		if !used[name] {
			extra = append(extra, name)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		return "", fmt.Errorf("routing: %s does not take %s", pattern, strings.Join(extra, ", "))
	}
	return "/" + strings.Join(out, "/"), nil
}

// URL is Expand with the console origin in front.
func URL(origin, pattern string, params map[string]string) (string, error) {
	path, err := Expand(pattern, params)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(origin, "/") + path, nil
}

// Org is the organization's overview page.
func Org(origin, org string) (string, error) {
	return URL(origin, RouteOrg, map[string]string{"org": org})
}

// Project is a project's page, addressed by the org slug and the project SLUG.
func Project(origin, org, projectSlug string) (string, error) {
	return URL(origin, RouteOrgProject, map[string]string{"org": org, "project": projectSlug})
}

// Job is one job's page.
func Job(origin, org, jobID string) (string, error) {
	return URL(origin, RouteOrgJobsID, map[string]string{"org": org, "id": jobID})
}

// Jobs is the org's job list.
func Jobs(origin, org string) (string, error) {
	return URL(origin, RouteOrgJobs, map[string]string{"org": org})
}

// ProjectSlug derives the slug the console minted for a project name.
//
// The CLI's `project get` wire carries the name and not the slug, and the console's `[project]`
// segment resolves the SLUG. The server mints it with the shared slugifier (#3665 generated one
// implementation into both sides), so the derivation here is the server's own rule — with one
// stated gap: when two names in an org slug to the same string the server suffixes the second
// (`pickFreeSlug`), and this cannot know that. Such a link 404s rather than opening the wrong
// project, which is the acceptable failure.
func ProjectSlug(projectName string) string {
	return names.Slugify(projectName, "project", names.SlugMaxLength)
}
