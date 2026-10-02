// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// docsTutorialsDir is the tutorials section, as seen from apps/cli/cmd.
func docsTutorialsDir() string {
	return filepath.Join(docsRepoRoot(), "apps", "docs", "content", "docs", "tutorials")
}

// TestHygCliDocs_EveryTutorialExampleResolves runs the reference pages' example check over the
// tutorials (#5241).
//
// A tutorial is the page a new user copies from line by line, and before this nothing read its
// commands: the reference guard is driven by a group → page registry, and no group documents onto a
// tutorial. The Online Boutique tutorial shipped `--project-id <name>` and a two-step plan/apply a
// single `alethia apply` already performs, and nothing could see either.
//
// Same three arms as TestHygCliDocs_EveryDocumentedExampleResolves — the command resolves, it is a
// leaf rather than a group that prints help and exits 0, and its flags and arguments are accepted —
// minus the group-to-page rule, because a tutorial uses commands from every group by design.
func TestHygCliDocs_EveryTutorialExampleResolves(t *testing.T) {
	dir := docsTutorialsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading %s: %v — the tutorials are this guard's whole subject, so an unreadable "+
			"directory is a failure, not a pass", dir, err)
	}
	var pages []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".mdx") {
			pages = append(pages, e.Name())
		}
	}
	sort.Strings(pages)

	checked := 0
	for _, page := range pages {
		for _, example := range docsFencedExamples(docsRead(t, filepath.Join(dir, page))) {
			checked++
			cmd, rest, err := rootCmd.Find(docsTokens(example)[1:])
			if err != nil {
				t.Errorf("tutorials/%s: %q does not resolve: %v", page, example, err)
				continue
			}
			if !cmd.Runnable() {
				t.Errorf("tutorials/%s: %q resolves to `%s`, a command GROUP — it would print help and "+
					"exit 0", page, example, cmd.CommandPath())
				continue
			}
			args := docsSplitArgs(t, cmd, rest, example)
			if err := cmd.ValidateArgs(args); err != nil {
				t.Errorf("tutorials/%s: %q passes %d argument(s) %v that `%s` does not accept: %v",
					page, example, len(args), args, cmd.CommandPath(), err)
			}
		}
	}
	// A ZERO CENSUS IS A FAILURE. A tutorial with no example, or an extractor that stopped matching,
	// would otherwise read as "every tutorial command works".
	if len(pages) == 0 || checked == 0 {
		t.Fatalf("read %d tutorial pages and %d `alethia …` examples under %s — nothing was checked",
			len(pages), checked, dir)
	}
}
