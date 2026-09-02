// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// A command group's docs page is part of the group, not a description of it.
//
// The CLI programme (#3612) puts each noun group's page inside the group's own scope for a
// measured reason: a group whose commands change and whose page does not is how a page comes to
// document a flag that no longer exists, or to omit a command entirely. `cluster get` shipped with
// no mention on its page and no line in the command tree, and nothing objected — because nothing
// was asking.
//
// This asks. For every group in the registry below it holds three things true at once:
//
//   - every leaf command has a section on its page, and appears in the command tree in index.mdx;
//   - every `alethia …` line the page shows RESOLVES against the real cobra tree — the command
//     exists, its flags exist, and the arguments are ones the command accepts;
//   - the registry itself is live: an entry naming a group that is gone is a failure, not a
//     silently-skipped row.
//
// ── THE REGISTRY ──────────────────────────────────────────────────────────────────────────────
//
// It is opt-in because the fourteen noun groups land one at a time; a guard turned on for all of
// them at once would be red for months and would be switched off rather than fixed. A group is
// added by the pass that finishes it, and the map only grows. #3664 is where it stops being a
// registry and becomes "every group".
//
// A page may carry MORE THAN ONE group — `organizations.mdx` documents org, members and teams, and
// `access.mdx` documents roles, grants and sso — so the "this example is outside the group" check
// below reads every group registered for the page rather than the one it is currently walking.
// Without that, a `alethia members list` example on the org group's page fails as foreign to `org`,
// and the only way to register the group would be to split the docs.
var docsGroups = map[string]string{
	// group command → docs page basename under apps/docs/content/docs/cli/commands
	"cluster": "clusters",
	"addon":   "addons",
	"agent":   "agents",
	"org":     "organizations",
	"members": "organizations",
	"teams":   "organizations",
	"roles":   "access",
	"grants":  "access",
	"sso":     "access",
}

// docsGroupsOnPage inverts the registry: which groups share one page.
//
// Derived from docsGroups rather than written beside it, because a second list of the same fact is
// a list that stops agreeing — and the failure would be silent in the safe direction: an example
// wrongly reported as foreign, or worse, a foreign one accepted because the page was thought to
// carry a group it does not.
func docsGroupsOnPage(page string) []string {
	var out []string
	for group, p := range docsGroups {
		if p == page {
			out = append(out, group)
		}
	}
	sort.Strings(out)
	return out
}

// docsRepoRoot is the repo root as seen from apps/cli/cmd.
func docsRepoRoot() string { return filepath.Join("..", "..", "..") }

// docsPagePath resolves a page basename to its file.
func docsPagePath(page string) string {
	return filepath.Join(docsRepoRoot(), "apps", "docs", "content", "docs", "cli", "commands", page+".mdx")
}

// docsRead reads a file that the guard's verdict depends on. An unreadable one is a FAILURE and
// never a skip: "I could not look" and "I looked and it was fine" must not be the same result.
func docsRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v — this guard's verdict depends on the file, so an absent one is a "+
			"failure rather than a pass", path, err)
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		t.Fatalf("%s is empty", path)
	}
	return string(b)
}

// docsLeaves returns a group's runnable subcommands, deepest-first paths as argument slices.
//
// Cobra's generated `help` and `completion` are not part of anyone's docs page, and neither is a
// hidden command; everything else a user can run must be documented.
func docsLeaves(group *cobra.Command) [][]string {
	var leaves [][]string
	var walk func(c *cobra.Command, path []string)
	walk = func(c *cobra.Command, path []string) {
		for _, sub := range c.Commands() {
			if sub.Hidden || sub.Name() == "help" || sub.Name() == "completion" {
				continue
			}
			next := append(append([]string{}, path...), sub.Name())
			if sub.Runnable() {
				leaves = append(leaves, next)
			}
			walk(sub, next)
		}
	}
	walk(group, nil)
	return leaves
}

// docsFencedExamples returns every `alethia …` invocation inside a fenced code block.
//
// Only fenced blocks, because inline code is prose — "run `alethia org switch`" names a command
// without claiming to be a complete invocation. Anything after a pipe belongs to the next process,
// and a trailing comment is not part of the command.
func docsFencedExamples(page string) []string {
	var out []string
	fenced := false
	for _, line := range strings.Split(page, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			fenced = !fenced
			continue
		}
		if !fenced {
			continue
		}
		cmd := strings.TrimSpace(line)
		if !strings.HasPrefix(cmd, "alethia ") {
			continue
		}
		if i := strings.Index(cmd, "|"); i >= 0 {
			cmd = cmd[:i]
		}
		if i := strings.Index(cmd, " #"); i >= 0 {
			cmd = cmd[:i]
		}
		out = append(out, strings.TrimSpace(cmd))
	}
	return out
}

// docsLookupFlag resolves one flag token against a command, long or short, `--flag`, `-f` or
// `--flag=value`. It returns nil when the flag does not exist on that command.
func docsLookupFlag(cmd *cobra.Command, token string) *pflag.Flag {
	name := strings.TrimLeft(token, "-")
	if i := strings.Index(name, "="); i >= 0 {
		name = name[:i]
	}
	if strings.HasPrefix(token, "--") {
		if f := cmd.Flags().Lookup(name); f != nil {
			return f
		}
		return cmd.InheritedFlags().Lookup(name)
	}
	if f := cmd.Flags().ShorthandLookup(name); f != nil {
		return f
	}
	return cmd.InheritedFlags().ShorthandLookup(name)
}

// docsSplitArgs separates the positional arguments from the flags and their values.
//
// It does NOT call cmd.ParseFlags: that writes into rootCmd's flag values, which are package
// globals shared with every other test in this file's package — a guard that mutates the thing it
// inspects would decide a later test's interactive arm. A boolean flag consumes no following
// token; any other flag consumes one unless it was written as `--flag=value`.
func docsSplitArgs(t *testing.T, cmd *cobra.Command, rest []string, example string) []string {
	t.Helper()
	var args []string
	for i := 0; i < len(rest); i++ {
		token := rest[i]
		if !strings.HasPrefix(token, "-") || token == "-" {
			args = append(args, token)
			continue
		}
		f := docsLookupFlag(cmd, token)
		if f == nil {
			t.Errorf("%q passes %s, which is not a flag of `%s`", example, token, cmd.CommandPath())
			continue
		}
		if f.Value.Type() != "bool" && !strings.Contains(token, "=") {
			i++ // the flag's value
		}
	}
	return args
}

// docsCommandTree returns the fenced command tree in index.mdx — the first fenced block that
// carries a top-level `├── `/`└── ` entry — and "" when the page has none.
//
// The bound is the whole point. Over the raw page the LAST top-level group's block runs to EOF:
// index.mdx ends `└── ops` and then carries ~70 further lines of callouts and other command
// examples, so a `\bname\b` search over that block could not fail. The registry only grows, and it
// grows until it contains whichever group is last.
func docsCommandTree(index string) string {
	var block []string
	fenced := false
	hasEntry := false
	for _, line := range strings.Split(index, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			if fenced && hasEntry {
				return strings.Join(block, "\n")
			}
			fenced = !fenced
			block, hasEntry = nil, false
			continue
		}
		if !fenced {
			continue
		}
		block = append(block, line)
		if strings.HasPrefix(line, "├── ") || strings.HasPrefix(line, "└── ") {
			hasEntry = true
		}
	}
	return ""
}

// docsIndexBlock returns the lines of the command tree in index.mdx that belong to one group: the
// line naming it, and the indented lines under it up to the next top-level entry.
//
// It searches the FENCED tree, never the raw page — see docsCommandTree for why an unbounded walk
// makes the assertion built on this block unfailable for the last group in the tree.
func docsIndexBlock(index, group string) string {
	tree := docsCommandTree(index)
	if tree == "" {
		return ""
	}
	head := regexp.MustCompile(`(?m)^[├└]── ` + regexp.QuoteMeta(group) + `\b`)
	loc := head.FindStringIndex(tree)
	if loc == nil {
		return ""
	}
	block := tree[loc[0]:]
	lines := strings.Split(block, "\n")
	for i := 1; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "├── ") || strings.HasPrefix(lines[i], "└── ") {
			return strings.Join(lines[:i], "\n")
		}
	}
	return block
}

// TestHygCliDocs_IndexBlockStopsAtTheClosingFence pins the bound the leaf-in-the-tree assertion
// rests on: the block for the LAST top-level entry must end at the closing fence.
//
// It runs on a fixture rather than on index.mdx because the defect it guards is only reachable for
// whichever group is last, and which group that is changes with the page. The prose below the fence
// names both leaves on purpose: unbounded, the block would swallow it and the `\bname\b` search in
// the test below would pass for a leaf that had been deleted from the tree.
func TestHygCliDocs_IndexBlockStopsAtTheClosingFence(t *testing.T) {
	const page = "# Commands\n\n```\nalethia\n├── cluster\n│   ├── list\n│   └── get [selector]\n└── ops\n    └── session --reason <r>\n```\n\nThe `ops` group opens a session; see get and list above.\n"

	block := docsIndexBlock(page, "ops")
	if block == "" {
		t.Fatal("the last top-level entry must still resolve to a block")
	}
	if strings.Contains(block, "The `ops` group") {
		t.Errorf("the last entry's block ran past the closing fence into the prose:\n%s", block)
	}
	if !strings.Contains(block, "session --reason") {
		t.Errorf("the block dropped the group's own leaves:\n%s", block)
	}

	if block := docsIndexBlock(page, "cluster"); strings.Contains(block, "ops") {
		t.Errorf("a group's block must stop at the next top-level entry:\n%s", block)
	}
	if got := docsIndexBlock(page, "runner"); got != "" {
		t.Errorf("a group absent from the tree has no block, got %q", got)
	}
	if got := docsIndexBlock("no fenced tree here", "cluster"); got != "" {
		t.Errorf("a page with no command tree has no block, got %q", got)
	}
}

// TestHygCliDocs_EveryLeafIsDocumented pins that a registered group's page and the command tree
// both mention every command the group can run.
func TestHygCliDocs_EveryLeafIsDocumented(t *testing.T) {
	if len(docsGroups) == 0 {
		t.Fatal("the registry is empty — every assertion in this file would be vacuous")
	}
	index := docsRead(t, docsPagePath("index"))

	checkedLeaves := 0
	for group, page := range docsGroups {
		groupCmd, _, err := rootCmd.Find([]string{group})
		if err != nil || groupCmd == rootCmd {
			t.Errorf("registry names group %q, which does not resolve — the registry only grows, "+
				"so a renamed or deleted group is a failure and never a skipped row", group)
			continue
		}
		body := docsRead(t, docsPagePath(page))
		block := docsIndexBlock(index, group)
		if block == "" {
			t.Errorf("group %q has no entry in the command tree in index.mdx", group)
		}

		leaves := docsLeaves(groupCmd)
		if len(leaves) == 0 {
			t.Errorf("group %q has no runnable subcommands — either it is not a group, or this "+
				"walk cannot see them, and either way the checks below say nothing", group)
			continue
		}
		for _, leaf := range leaves {
			checkedLeaves++
			heading := "## `alethia " + group + " " + strings.Join(leaf, " ") + "`"
			if !strings.Contains(body, heading) {
				t.Errorf("%s.mdx has no section for `alethia %s %s` (want a heading %q)",
					page, group, strings.Join(leaf, " "), heading)
			}
			if block != "" && !regexp.MustCompile(`\b`+regexp.QuoteMeta(leaf[len(leaf)-1])+`\b`).MatchString(block) {
				t.Errorf("`alethia %s %s` is missing from the command tree in index.mdx:\n%s",
					group, strings.Join(leaf, " "), block)
			}
		}
	}
	if checkedLeaves == 0 {
		t.Fatal("no leaf command was checked — the registry resolved nothing")
	}
}

// TestHygCliDocs_EveryDocumentedExampleResolves executes every documented invocation against the
// real cobra tree, short of running it: the command exists and is a leaf, its flags exist, and its
// arguments are ones it accepts.
//
// A `--help` that exits 0 proves a command RESOLVES, not that the line a reader will copy works.
// The three ways a documented example rots — a renamed command that silently resolves to its
// parent's help, a flag that moved, an argument arity that changed — are each a separate arm here.
func TestHygCliDocs_EveryDocumentedExampleResolves(t *testing.T) {
	if len(docsGroups) == 0 {
		t.Fatal("the registry is empty — every assertion in this file would be vacuous")
	}
	checkedExamples := 0
	// Over PAGES, not over groups: a page shared by three groups would otherwise have every one of
	// its examples checked three times, and each miss reported three times.
	seenPage := map[string]bool{}
	for _, page := range docsGroups {
		if seenPage[page] {
			continue
		}
		seenPage[page] = true
		body := docsRead(t, docsPagePath(page))
		examples := docsFencedExamples(body)
		if len(examples) == 0 {
			t.Errorf("%s.mdx shows no `alethia …` invocation — a command page with no example is "+
				"a page this guard cannot check", page)
			continue
		}
		for _, example := range examples {
			checkedExamples++
			tokens := strings.Fields(example)[1:] // drop "alethia"
			cmd, rest, err := rootCmd.Find(tokens)
			if err != nil {
				t.Errorf("%q does not resolve: %v", example, err)
				continue
			}
			if !cmd.Runnable() {
				// This is the silent one. `alethia cluster gett` resolves to `cluster`, which
				// prints help and exits 0, so a `--help` smoke test would call it fine.
				t.Errorf("%q resolves to `%s`, which is a command GROUP, not a leaf — it would "+
					"print help and exit 0", example, cmd.CommandPath())
				continue
			}
			owners := docsGroupsOnPage(page)
			owned := false
			for _, owner := range owners {
				if strings.HasPrefix(cmd.CommandPath(), "alethia "+owner+" ") {
					owned = true
					break
				}
			}
			if !owned {
				t.Errorf("%q is on %s.mdx but resolves to `%s`, outside the group(s) %v that page documents",
					example, page, cmd.CommandPath(), owners)
			}
			args := docsSplitArgs(t, cmd, rest, example)
			if err := cmd.ValidateArgs(args); err != nil {
				t.Errorf("%q passes %d argument(s) %v that `%s` does not accept: %v",
					example, len(args), args, cmd.CommandPath(), err)
			}
		}
	}
	if checkedExamples == 0 {
		t.Fatal("no example was executed — every assertion above was vacuous")
	}
}

// TestHygCliDocs_EveryLeafIsShownAtLeastOnce pins the other direction: a command with a heading and
// no runnable example is a section a reader cannot copy from.
func TestHygCliDocs_EveryLeafIsShownAtLeastOnce(t *testing.T) {
	checked := 0
	for group, page := range docsGroups {
		groupCmd, _, err := rootCmd.Find([]string{group})
		if err != nil || groupCmd == rootCmd {
			continue // reported by TestHygCliDocs_EveryLeafIsDocumented
		}
		examples := docsFencedExamples(docsRead(t, docsPagePath(page)))
		for _, leaf := range docsLeaves(groupCmd) {
			checked++
			shown := false
			for _, example := range examples {
				cmd, _, err := rootCmd.Find(strings.Fields(example)[1:])
				if err == nil && cmd.CommandPath() == "alethia "+group+" "+strings.Join(leaf, " ") {
					shown = true
					break
				}
			}
			if !shown {
				t.Errorf("`alethia %s %s` has no runnable example on %s.mdx",
					group, strings.Join(leaf, " "), page)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no leaf was checked — every assertion above was vacuous")
	}
}
