// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/alethialabs-io/alethialabs/apps/cli/cmd"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
)

// docsDir is the committed docs content, relative to this package.
const docsDir = "../../../docs/content/docs"

// testSource is the source the real tree gives.
func testSource(t *testing.T) source {
	t.Helper()
	_, doc := cmd.DocTree()
	if len(doc.Commands) == 0 {
		t.Fatal("the tree describes no command; every assertion below would be vacuous")
	}
	return newSource(doc)
}

// TestCommittedPagesAreGenerated is the -check: a committed page whose generated blocks are not
// what the generator writes fails here, with the command that fixes it.
func TestCommittedPagesAreGenerated(t *testing.T) {
	pages, err := generatePages(os.DirFS(docsDir), docsDir, testSource(t))
	if err != nil {
		t.Fatalf("generatePages: %v", err)
	}
	want := map[string]bool{
		"reference/cli/index.mdx":  false,
		"reference/cli/errors.mdx": false,
		"reference/cli/mcp.mdx":    false,
	}
	for _, p := range pages {
		rel, err := filepath.Rel(docsDir, p.Path)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := want[filepath.ToSlash(rel)]; ok {
			want[filepath.ToSlash(rel)] = true
		}
		if p.Generated != p.Committed {
			t.Errorf("%s: a generated block is stale; run `go run ./tools/gendocs` from apps/cli", p.Path)
		}
	}
	for rel, seen := range want {
		if !seen {
			t.Errorf("%s carries no generated block; the reference it should hold is unchecked", rel)
		}
	}
}

// TestTheCommandsBlockListsEveryRunnableCommand holds the reference to the tree: every listed
// runnable command has a row, and a command the default build hides has none.
func TestTheCommandsBlockListsEveryRunnableCommand(t *testing.T) {
	src := testSource(t)
	body, err := render("commands", src)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	runnable := 0
	for _, c := range src.doc.Commands {
		if !c.Runnable {
			continue
		}
		runnable++
		if !strings.Contains(body, "| `"+c.Path+"` |") {
			t.Errorf("%q is listed and runnable, and has no row", c.Path)
		}
	}
	if runnable == 0 {
		t.Fatal("no runnable command was described")
	}
	if !strings.Contains(body, "| `alethia mcp` |") {
		t.Error("`alethia mcp` has no row")
	}
	if strings.Contains(body, "`alethia ops") {
		t.Error("the reference lists `alethia ops`, which a default build hides")
	}
}

// fakeSource is a two-command description for the marker tests.
func fakeSource() source {
	return newSource(cmdmeta.Document{
		Groups: []cmdmeta.Group{{ID: "start", Title: "Start here:"}},
		Commands: []cmdmeta.CommandDoc{
			{
				Path: "alethia up", Short: "Go from <nothing> to {running} | done", Group: "start", Runnable: true,
				Mutates: true, LongRunning: true, DryRun: cmdmeta.DryRunClient,
				Examples: []cmdmeta.Example{{Cmd: "alethia up", Note: "Deploy"}, {Cmd: "alethia up --yes"}},
				Flags:    []cmdmeta.FlagDoc{{Name: "yes", Shorthand: "y", Type: "bool", Default: "false", Usage: "Skip the `<confirm>` step"}},
			},
			{Path: "alethia bare", Short: "No examples", Group: "start", Runnable: true, DryRun: cmdmeta.DryRunNone},
		},
	})
}

// TestRewriteReplacesOnlyTheBlock checks that prose around a block survives, that a block's old
// body is replaced, and that a second run changes nothing.
func TestRewriteReplacesOnlyTheBlock(t *testing.T) {
	in := "intro\n\n{/* gendocs: examples alethia up */}\nstale body\n{/* /gendocs */}\n\noutro\n"
	out, err := rewrite(in, fakeSource())
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if strings.Contains(out, "stale body") {
		t.Errorf("the old body survived:\n%s", out)
	}
	for _, want := range []string{"intro\n", "\noutro\n", "```bash\n# Deploy\nalethia up\n\nalethia up --yes\n```"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	again, err := rewrite(out, fakeSource())
	if err != nil {
		t.Fatalf("second rewrite: %v", err)
	}
	if again != out {
		t.Errorf("a second run changed the page:\n%s\n---\n%s", out, again)
	}
}

// TestRenderedCellsAreSafeMDX checks that a sentence cannot open JSX, an expression or a new cell,
// and that a code span keeps its text.
func TestRenderedCellsAreSafeMDX(t *testing.T) {
	body, err := render("commands", fakeSource())
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(body, `Go from &lt;nothing&gt; to \{running\} \| done`) {
		t.Errorf("the summary was not escaped:\n%s", body)
	}
	if !strings.Contains(body, "Changes, queues a job, `--dry-run`") {
		t.Errorf("the effect column is wrong:\n%s", body)
	}
	flags, err := render("flags alethia up", fakeSource())
	if err != nil {
		t.Fatalf("render flags: %v", err)
	}
	if !strings.Contains(flags, "| `-y`, `--yes` | — | Skip the `<confirm>` step |") {
		t.Errorf("the flag row is wrong:\n%s", flags)
	}
}

// TestRewriteRefusesWhatItCannotRender drives every refusal.
func TestRewriteRefusesWhatItCannotRender(t *testing.T) {
	cases := map[string]string{
		"unclosed":         "{/* gendocs: commands */}\nbody\n",
		"stray close":      "text\n{/* /gendocs */}\n",
		"nested":           "{/* gendocs: commands */}\n{/* gendocs: exit-codes */}\n{/* /gendocs */}\n",
		"unknown block":    "{/* gendocs: everything */}\n{/* /gendocs */}\n",
		"missing argument": "{/* gendocs: examples */}\n{/* /gendocs */}\n",
		"extra argument":   "{/* gendocs: commands alethia up */}\n{/* /gendocs */}\n",
		"unlisted command": "{/* gendocs: flags alethia ops session */}\n{/* /gendocs */}\n",
		"no examples":      "{/* gendocs: examples alethia bare */}\n{/* /gendocs */}\n",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if out, err := rewrite(in, fakeSource()); err == nil {
				t.Errorf("rewrite accepted it:\n%s", out)
			}
		})
	}
}

// TestGeneratePagesRefusesAnEmptyCorpus is the vacuity refusal: a docs tree with no block at all
// must not read as a tree whose blocks are all current.
func TestGeneratePagesRefusesAnEmptyCorpus(t *testing.T) {
	fsys := fstest.MapFS{"reference/cli/index.mdx": {Data: []byte("no blocks here\n")}}
	if _, err := generatePages(fsys, "docs", fakeSource()); err == nil {
		t.Fatal("a corpus with no generated block was accepted")
	}
	fsys["reference/cli/errors.mdx"] = &fstest.MapFile{Data: []byte("{/* gendocs: exit-codes */}\n{/* /gendocs */}\n")}
	pages, err := generatePages(fsys, "docs", fakeSource())
	if err != nil {
		t.Fatalf("generatePages: %v", err)
	}
	if len(pages) != 1 || !strings.Contains(pages[0].Generated, "| `130` | `interrupted` |") {
		t.Fatalf("pages = %+v", pages)
	}
}

// TestReleaseFiles writes the man pages and completions and checks one page per listed command,
// none for a hidden one, and a non-empty script per shell.
func TestReleaseFiles(t *testing.T) {
	root, doc := cmd.DocTree()
	dir := t.TempDir()
	if err := writeMan(root, filepath.Join(dir, "man")); err != nil {
		t.Fatalf("writeMan: %v", err)
	}
	if err := writeCompletions(root, filepath.Join(dir, "completions")); err != nil {
		t.Fatalf("writeCompletions: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "man", "alethia.1")); err != nil {
		t.Errorf("no page for the root: %v", err)
	}
	for _, c := range doc.Commands {
		if c.Path == "alethia help" {
			continue
		}
		name := strings.ReplaceAll(c.Path, " ", "-") + ".1"
		if _, err := os.Stat(filepath.Join(dir, "man", name)); err != nil {
			t.Errorf("%q has no man page: %v", c.Path, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "man", "alethia-ops.1")); err == nil {
		t.Error("`alethia ops` has a man page, and a default build hides it")
	}
	for shell, name := range completionFile {
		info, err := os.Stat(filepath.Join(dir, "completions", name))
		if err != nil || info.Size() == 0 {
			t.Errorf("%s completion %s is missing or empty: %v", shell, name, err)
		}
	}
}

// TestRunArguments drives the program's own argument handling: -check on the committed pages,
// the release files, and the combinations it refuses.
func TestRunArguments(t *testing.T) {
	var out strings.Builder
	if err := run([]string{"-check", "-docs", docsDir}, &out); err != nil {
		t.Fatalf("-check on the committed pages: %v", err)
	}
	if !strings.Contains(out.String(), "0 were stale") {
		t.Errorf("-check reported %q", out.String())
	}

	dir := t.TempDir()
	out.Reset()
	if err := run([]string{"-man", filepath.Join(dir, "man"), "-completions", filepath.Join(dir, "completions")}, &out); err != nil {
		t.Fatalf("release files: %v", err)
	}
	if !strings.Contains(out.String(), "man pages: ") || !strings.Contains(out.String(), "completions: ") {
		t.Errorf("release run reported %q", out.String())
	}

	for name, args := range map[string][]string{
		"stray argument":   {"extra"},
		"unknown flag":     {"-nope"},
		"check with man":   {"-check", "-man", dir},
		"missing docs dir": {"-check", "-docs", filepath.Join(dir, "absent")},
	} {
		t.Run(name, func(t *testing.T) {
			if err := run(args, &strings.Builder{}); err == nil {
				t.Errorf("run(%v) succeeded", args)
			}
		})
	}
}
