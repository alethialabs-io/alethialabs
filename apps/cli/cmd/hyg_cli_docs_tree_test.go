// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// The command tree in index.mdx is a CONTRACT, not a picture.
//
// `alethia jobs get <job_id>` and `alethia jobs get [job_id]` say different things to a reader: the
// first says the id is required, which is what makes the reader go and find one. #3740 made those
// three ids optional and gave the commands a picker, and the tree went on showing angle brackets
// for five weeks. Nothing objected, because the docs guard only reads the pages of REGISTERED
// groups and `jobs` was not one — and even for a registered group it read the page's examples and
// the presence of a leaf in the tree, never what the tree SAID about that leaf's arguments.
//
// This reads it. For every leaf in the registry, the brackets in the tree must agree with the
// brackets in the command's own Use string, which is the string cobra prints in --help. Two
// renderings of one fact, checked against each other rather than typed twice.

// docsTreeOnlyGroups holds groups the COMMAND TREE contract applies to but whose page does not yet
// satisfy the full page contract in hyg_cli_docs_test.go.
//
// One notch finer than that file's registry, and for a reason it names itself: a guard turned on
// for everything at once is red for months and gets switched off rather than fixed. The tree
// contract is cheap to satisfy — it is one line per leaf in one file — and it is the half that was
// actually wrong, so it can go first.
//
// `jobs` is here rather than in docsGroups because jobs.mdx does not yet satisfy two of that
// registry's assertions, both of which are real work in someone else's scope and neither of which
// is this defect:
//
//   - its `jobs logs` fence shows a USAGE line (`alethia jobs logs [job_id] [-f/--follow]`) rather
//     than an invocation. #3784's rewrite of docsFencedExamples — collect only from shell-TAGGED
//     fences — does not reach it, because that fence IS tagged; the line needs replacing with a
//     runnable example, and #3801's placeholder ratchet will require the same thing.
//   - its "Waiting for jobs" section shows `alethia project plan` and `alethia project apply` in a
//     cross-group workflow, which the page contract reads as a page documenting another group's
//     command. That rule is not wrong; the exception is real, and deciding how a page declares one
//     is a change to the shared docs guard rather than to this group.
//
// Entries move OUT of this map into docsGroups. It is not a place to leave things.
var docsTreeOnlyGroups = map[string]string{
	"jobs": "jobs",
}

// docsTreeContractGroups is every group the tree contract applies to.
func docsTreeContractGroups(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	for group, page := range docsGroups {
		out[group] = page
	}
	for group, page := range docsTreeOnlyGroups {
		if _, already := out[group]; already {
			t.Errorf("%q is in BOTH docsGroups and docsTreeOnlyGroups — the tree-only map is a "+
				"staging area, and an entry that has graduated must leave it", group)
		}
		out[group] = page
	}
	if len(out) == 0 {
		t.Fatal("no group is under the tree contract — every assertion below would be vacuous")
	}
	return out
}

// docsLeafPages registers TOP-LEVEL LEAF commands — the ones that are not a group and so cannot be
// reached by docsGroups, whose every assertion starts by walking a group's subcommands.
//
// `alethia open`, `alethia version` and `alethia update` are the shell's whole user-facing surface
// and were outside every docs guard for exactly that structural reason: the registry's shape
// assumed a noun group, and these three are verbs hanging off the root.
var docsLeafPages = map[string]string{
	// command → docs page, relative to the repository root
	"open":    "apps/docs/content/docs/cli/identity.mdx",
	"version": "apps/docs/content/docs/cli/identity.mdx",
	"update":  "apps/docs/content/docs/cli/installation.mdx",
}

// docsTreeArgSpec is the argument shape of one command line, as brackets alone.
//
// Only the shape: `<job_id>` and `<id>` are the same statement to this guard, because the guard's
// question is "does the tree agree with --help about what is REQUIRED", not "do two files spell a
// placeholder the same way". A name check would fail on `<project_name>` versus `<name>` and would
// be switched off rather than fixed.
type docsTreeArgSpec struct {
	required int
	optional int
}

// docsArgToken classifies one whitespace-separated token of a usage line.
var (
	docsRequiredArg = regexp.MustCompile(`^<[^>]+>$`)
	docsOptionalArg = regexp.MustCompile(`^\[[^\]]+\]$`)
	docsFlagToken   = regexp.MustCompile(`^\[?-`)
)

// docsParseArgSpec reads the positional arguments out of a usage line's tail.
//
// A token starting with `-` is a flag and CONSUMES the value token after it, which is the whole
// subtlety: `login [--web-origin <url>]` has no positional arguments at all, and a walk that
// counted `<url>` would read it as one required argument and report every line with a valued flag.
// `[-f/--follow]` and `[--key-file <f>]` are the two bracketed spellings the tree uses.
func docsParseArgSpec(tail string) docsTreeArgSpec {
	var spec docsTreeArgSpec
	tokens := strings.Fields(tail)
	for i := 0; i < len(tokens); i++ {
		// An alternation group — `(--role <name|id> | --permission <key>)` on `grants add` — wraps
		// its first and last token in parentheses and separates them with a bare pipe. Unwrapping
		// them turns the group back into the flags it is made of; without this the `<name|id>`
		// after `(--role` was counted as a required POSITIONAL, because the token before it did
		// not start with a dash.
		tok := strings.Trim(tokens[i], "()")
		if tok == "|" || tok == "" {
			continue
		}
		if docsFlagToken.MatchString(tok) {
			// A bracketed flag group carries its own value inside the brackets when it has one,
			// so only a BARE flag consumes the next token.
			if !strings.HasPrefix(tok, "[") && i+1 < len(tokens) &&
				(docsRequiredArg.MatchString(strings.Trim(tokens[i+1], "()")) ||
					docsOptionalArg.MatchString(strings.Trim(tokens[i+1], "()"))) {
				i++
			}
			continue
		}
		switch {
		case docsRequiredArg.MatchString(tok):
			spec.required++
		case docsOptionalArg.MatchString(tok):
			spec.optional++
		}
	}
	return spec
}

// docsTreeLine returns the tree line for one command path, or "" when the tree does not show it.
//
// The path is matched by its LAST element inside the group's block, which is how
// TestHygCliDocs_EveryLeafIsDocumented already reads the tree; this adds the tail of the line.
func docsTreeLine(index, group, leaf string) string {
	block := docsIndexBlock(index, group)
	if block == "" {
		return ""
	}
	entry := regexp.MustCompile(`(?m)^[│ ]*[├└]── ` + regexp.QuoteMeta(leaf) + `\b(.*)$`)
	m := entry.FindStringSubmatch(block)
	if m == nil {
		return ""
	}
	line := m[1]
	// A trailing `# …` comment is prose, not part of the invocation.
	if i := strings.Index(line, "#"); i >= 0 {
		line = line[:i]
	}
	return strings.TrimSpace(line)
}

// docsUseTail returns the argument portion of a command's Use string.
func docsUseTail(cmd *cobra.Command) string {
	fields := strings.Fields(cmd.Use)
	if len(fields) <= 1 {
		return ""
	}
	return strings.Join(fields[1:], " ")
}

// TestHygCliDocs_TheTreeAgreesWithTheUsageString compares the two renderings of each registered
// leaf's argument arity.
func TestHygCliDocs_TheTreeAgreesWithTheUsageString(t *testing.T) {
	index := docsRead(t, docsPagePath("index"))
	checked := 0

	for group := range docsTreeContractGroups(t) {
		groupCmd, _, err := rootCmd.Find([]string{group})
		if err != nil || groupCmd == rootCmd {
			t.Errorf("group %q is under the tree contract but does not resolve", group)
			continue
		}
		for _, leaf := range docsLeaves(groupCmd) {
			name := leaf[len(leaf)-1]
			line := docsTreeLine(index, group, name)
			cmd, _, err := rootCmd.Find(append([]string{group}, leaf...))
			if err != nil {
				t.Errorf("`alethia %s %s` does not resolve", group, strings.Join(leaf, " "))
				continue
			}
			checked++
			want := docsParseArgSpec(docsUseTail(cmd))
			got := docsParseArgSpec(line)
			if got != want {
				t.Errorf("the command tree in index.mdx shows `%s %s` with %d required and %d "+
					"optional argument(s), but `%s` takes %d required and %d optional.\n"+
					"      Angle brackets tell a reader to go and find a value first. `%s`",
					name, line, got.required, got.optional,
					cmd.CommandPath(), want.required, want.optional, cmd.Use)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no leaf was compared — the registry resolved nothing, so this guard read nothing")
	}
}

// TestHygCliDocs_ArgSpecParserReadsTheTreesSpellings is the parser's own test.
//
// A parser that returned {0,0} for everything would make the guard above pass on every line, so it
// is driven here against the real spellings the tree uses — including the two that would break a
// naive count: a required flag with a value, and a bracketed flag group with a value inside it.
func TestHygCliDocs_ArgSpecParserReadsTheTreesSpellings(t *testing.T) {
	cases := map[string]docsTreeArgSpec{
		"":                                  {0, 0},
		"<job_id>":                          {1, 0},
		"[job_id]":                          {0, 1},
		"[console|docs]":                    {0, 1},
		"<key> <value>":                     {2, 0},
		"[--status <S>] [-n/--limit <N>]":   {0, 0},
		"<job_id> [-f/--follow]":            {1, 0},
		"[-f/--force] [--web-origin <url>]": {0, 0},
		"<name> --region <r>":               {1, 0},
		"-j <job_id> [--key-file <f>]":      {0, 0},
		"[project] [--format <f>]":          {0, 1},
		// The alternation group on `grants add`: two flags, no positionals. Every token in it is
		// wrapped or separated by punctuation the other spellings never use.
		"[--principal <email|team|id>] (--role <name|id> | --permission <key>) [--effect allow]": {0, 0},
		"(--a <x> | --b <y>)": {0, 0},
	}
	for line, want := range cases {
		if got := docsParseArgSpec(line); got != want {
			t.Errorf("docsParseArgSpec(%q) = %+v, want %+v", line, got, want)
		}
	}
}

// TestHygCliDocs_TreeLineIsFoundForARealLeaf proves docsTreeLine finds lines at all.
//
// Without it the guard above compares {0,0} against {0,0} for a leaf whose tree line it failed to
// locate, and reports clean — the "nothing found is not nothing wrong" shape, which for a
// comparison guard is invisible because both sides collapse to the same empty value.
func TestHygCliDocs_TreeLineIsFoundForARealLeaf(t *testing.T) {
	index := docsRead(t, docsPagePath("index"))
	found := 0
	for group := range docsTreeContractGroups(t) {
		groupCmd, _, err := rootCmd.Find([]string{group})
		if err != nil || groupCmd == rootCmd {
			continue
		}
		for _, leaf := range docsLeaves(groupCmd) {
			if docsTreeLine(index, group, leaf[len(leaf)-1]) != "" {
				found++
			}
		}
	}
	if found == 0 {
		t.Fatal("docsTreeLine matched no leaf line anywhere in the registry's groups — every " +
			"comparison in TestHygCliDocs_TheTreeAgreesWithTheUsageString is empty against empty")
	}

	// A leaf that is genuinely absent must come back empty rather than matching something else.
	if got := docsTreeLine(index, "cluster", "definitely-not-a-leaf"); got != "" {
		t.Errorf("an absent leaf matched %q", got)
	}
}

// TestHygCliDocs_EveryShellLeafIsDocumented is docsGroups' contract for the commands its SHAPE
// cannot reach.
//
// Every assertion in hyg_cli_docs_test.go begins by walking a group's subcommands, so a top-level
// leaf — `alethia open`, `alethia version`, `alethia update` — resolves to a command with no
// children and is reported as "not a group" rather than checked. All three were outside every docs
// guard for that structural reason alone, which is the kind of gap a registry keyed on the wrong
// noun leaves behind.
//
// The page is named per command because they are not all on one: `update` belongs with installing
// the CLI, the other two with using it.
func TestHygCliDocs_EveryShellLeafIsDocumented(t *testing.T) {
	if len(docsLeafPages) == 0 {
		t.Fatal("no top-level leaf is registered — every assertion here would be vacuous")
	}
	index := docsRead(t, docsPagePath("index"))
	tree := docsCommandTree(index)
	if tree == "" {
		t.Fatal("index.mdx has no fenced command tree, so the tree half of this check reads nothing")
	}

	for name, page := range docsLeafPages {
		cmd, _, err := rootCmd.Find([]string{name})
		if err != nil || cmd == rootCmd {
			t.Errorf("the registry names %q, which does not resolve — the registry only grows, so "+
				"a renamed or deleted command is a failure and never a skipped row", name)
			continue
		}
		if !cmd.Runnable() {
			t.Errorf("%q is not runnable — it belongs in docsGroups, not here", name)
			continue
		}
		body := shellDocsRead(t, page)

		// Either heading level. identity.mdx nests these under "## Utility Commands", so they are
		// h3 there and h2 would be wrong; installation.mdx has `update` at the top level.
		if !strings.Contains(body, "## `alethia "+name+"`") {
			t.Errorf("%s has no section for `alethia %s` (want a `## ` or `### ` heading naming it)",
				page, name)
		}
		if !regexp.MustCompile(`(?m)^[├└]── ` + regexp.QuoteMeta(name) + `\b`).MatchString(tree) {
			t.Errorf("`alethia %s` is missing from the command tree in index.mdx", name)
		}
		if !strings.Contains(body, "alethia "+name) {
			t.Errorf("%s never shows `alethia %s` as an invocation a reader could copy", page, name)
		}

		// The tree line's argument arity must agree with the command's own Use string, exactly as
		// it must for a group's leaves.
		line := docsTreeLineTopLevel(tree, name)
		want := docsParseArgSpec(docsUseTail(cmd))
		if got := docsParseArgSpec(line); got != want {
			t.Errorf("the command tree shows `%s %s` with %d required and %d optional argument(s), "+
				"but `%s` takes %d required and %d optional",
				name, line, got.required, got.optional, cmd.CommandPath(), want.required, want.optional)
		}
	}
}

// docsTreeLineTopLevel returns the argument tail of a top-level entry in the command tree.
func docsTreeLineTopLevel(tree, name string) string {
	entry := regexp.MustCompile(`(?m)^[├└]── ` + regexp.QuoteMeta(name) + `\b(.*)$`)
	m := entry.FindStringSubmatch(tree)
	if m == nil {
		return ""
	}
	line := m[1]
	if i := strings.Index(line, "#"); i >= 0 {
		line = line[:i]
	}
	return strings.TrimSpace(line)
}
