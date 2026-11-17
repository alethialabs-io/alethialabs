// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmdmeta

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// noop is a run function, so a test command is runnable.
func noop(*cobra.Command, []string) {}

// testGroups are the help groups of the test tree.
var testGroups = []Group{{ID: "work", Title: "Work:"}, {ID: "tool", Title: "Tool:"}}

// testTree builds a small tree with every shape the registry meets: a runnable top-level command,
// a group with runnable children, a cloud-specific command, a command behind a capability with a
// child of its own, and a command that already defines --dry-run.
func testTree() *cobra.Command {
	root := &cobra.Command{Use: "tool", Version: "1.2.3", Run: noop}
	root.PersistentFlags().StringP("output", "o", "table", "Output format")

	status := &cobra.Command{Use: "status", Short: "Show status", Run: noop}

	thing := &cobra.Command{Use: "thing", Short: "Manage things", Aliases: []string{"things"}}
	thing.PersistentFlags().String("project", "", "Project name")
	list := &cobra.Command{Use: "list", Short: "List things", Run: noop}
	list.Flags().Int("limit", 20, "How many")
	hidden := list.Flags().VarPF(list.Flags().Lookup("limit").Value, "cap", "", "Old spelling")
	hidden.Hidden = true
	remove := &cobra.Command{Use: "remove [id]", Short: "Remove a thing", Long: "Removes one thing.", Run: noop}
	remove.Flags().Bool(DryRunFlag, false, "The command's own dry run")
	create := &cobra.Command{Use: "create", Short: "Create a thing", Run: noop}
	onlyEast := &cobra.Command{Use: "east", Short: "Connect the east cloud", Run: noop}
	thing.AddCommand(list, remove, create, onlyEast)

	admin := &cobra.Command{Use: "admin", Short: "Privileged", Run: noop}
	purge := &cobra.Command{Use: "purge", Short: "Purge", Run: noop}
	admin.AddCommand(purge)

	root.AddCommand(status, thing, admin)
	return root
}

// testEntries are the entries for testTree, complete and correct.
func testEntries() []Meta {
	return []Meta{
		{Path: "tool", Output: OutputNone, Idempotent: true},
		{Path: "tool status", Group: "tool", Output: OutputTable, Idempotent: true},
		{Path: "tool thing", Group: "work"},
		{Path: "tool thing list", Output: OutputTable, Idempotent: true, Examples: []Example{
			{Cmd: "tool thing list", Note: "Every thing in the active project"},
			{Cmd: "tool thing list --limit 5"},
		}},
		{Path: "tool thing remove", Output: OutputTable, Mutates: true, Destructive: true, Idempotent: true, DryRun: DryRunServer},
		{Path: "tool thing create", Output: OutputSecret, Mutates: true, LongRunning: true, DryRun: DryRunClient},
		{Path: "tool thing east", Output: OutputTable, Mutates: true, Clouds: []string{"east", "far-east"}},
		{Path: "tool admin", Group: "tool", Output: OutputNone, Capability: "admin"},
		{Path: "tool admin purge", Output: OutputTable, Mutates: true, Destructive: true},
		{Path: "tool help", Group: "tool", Output: OutputNone},
		{Path: "tool completion", Group: "tool"},
		{Path: "tool completion bash", Output: OutputDocument},
		{Path: "tool completion zsh", Output: OutputDocument},
		{Path: "tool completion fish", Output: OutputDocument},
		{Path: "tool completion powershell", Output: OutputDocument},
	}
}

// find returns the command at a path below root.
func find(t *testing.T, root *cobra.Command, path ...string) *cobra.Command {
	t.Helper()
	cmd, _, err := root.Find(path)
	if err != nil || cmd.CommandPath() != root.Name()+" "+strings.Join(path, " ") {
		t.Fatalf("no command at %v: %v", path, err)
	}
	return cmd
}

// allOn and allOff answer every capability and cloud question one way.
var (
	allOn  = Options{}
	allOff = Options{
		Enabled:      func(string) bool { return false },
		CloudEnabled: func(string) bool { return false },
	}
)

func TestRegistry_HoldsItsGroupsAndEntries(t *testing.T) {
	r := NewRegistry(testGroups, testEntries())

	if got := r.Groups(); !slices.Equal(got, testGroups) {
		t.Errorf("Groups() = %v, want %v", got, testGroups)
	}
	// The slice is a copy: changing it must not change the registry.
	r.Groups()[0].ID = "changed"
	if r.Groups()[0].ID != "work" {
		t.Error("Groups() handed out the registry's own slice")
	}

	m, ok := r.Lookup("tool thing remove")
	if !ok || !m.Destructive || m.DryRun != DryRunServer {
		t.Errorf("Lookup(tool thing remove) = %+v, %v", m, ok)
	}
	if _, ok := r.Lookup("tool nothing"); ok {
		t.Error("Lookup found an entry that was never added")
	}

	paths := r.Paths()
	if len(paths) != len(testEntries()) || !slices.IsSorted(paths) {
		t.Errorf("Paths() = %v, want %d sorted paths", paths, len(testEntries()))
	}
}

func TestApply_GroupsExamplesAndAnnotations(t *testing.T) {
	root := testTree()
	foreign := "example.test/keep"
	find(t, root, "thing", "list").Annotations = map[string]string{foreign: "yes"}

	r := NewRegistry(testGroups, testEntries())
	r.Apply(root, allOn)
	// A second Apply must leave the tree exactly as the first did.
	r.Apply(root, allOn)

	if got := len(root.Groups()); got != len(testGroups) {
		t.Errorf("the root has %d help groups after applying twice, want %d", got, len(testGroups))
	}
	for path, group := range map[string]string{"status": "tool", "thing": "work", "admin": "tool", "help": "tool", "completion": "tool"} {
		if got := find(t, root, path).GroupID; got != group {
			t.Errorf("%s is in help group %q, want %q", path, got, group)
		}
	}
	if got := find(t, root, "thing", "list").GroupID; got != "" {
		t.Errorf("a command below the top level was given help group %q", got)
	}

	list := find(t, root, "thing", "list")
	wantExample := "  # Every thing in the active project\n  tool thing list\n  tool thing list --limit 5"
	if list.Example != wantExample {
		t.Errorf("Example = %q, want %q", list.Example, wantExample)
	}
	if list.Annotations[foreign] != "yes" {
		t.Error("Apply removed an annotation it does not own")
	}
	if list.Annotations[AnnotationIdempotent] != "true" || list.Annotations[AnnotationOutput] != "table" {
		t.Errorf("annotations of a read = %v", list.Annotations)
	}
	if _, set := list.Annotations[AnnotationMutates]; set {
		t.Error("a boolean that is not set was written as an annotation")
	}

	remove := find(t, root, "thing", "remove")
	for key, want := range map[string]string{
		AnnotationMutates: "true", AnnotationDestructive: "true", AnnotationIdempotent: "true",
		AnnotationDryRun: "server", AnnotationOutput: "table",
	} {
		if got := remove.Annotations[key]; got != want {
			t.Errorf("remove: %s = %q, want %q", key, got, want)
		}
	}
	create := find(t, root, "thing", "create")
	if create.Annotations[AnnotationLongRunning] != "true" || create.Annotations[AnnotationOutput] != "secret" {
		t.Errorf("annotations of create = %v", create.Annotations)
	}
	if got := find(t, root, "thing", "east").Annotations[AnnotationClouds]; got != "east,far-east" {
		t.Errorf("clouds annotation = %q", got)
	}
	if got := find(t, root, "admin").Annotations[AnnotationCapability]; got != "admin" {
		t.Errorf("capability annotation = %q", got)
	}
}

func TestApply_AnAnnotationThatNoLongerHoldsIsRemoved(t *testing.T) {
	root := testTree()
	NewRegistry(testGroups, testEntries()).Apply(root, allOn)

	entries := testEntries()
	for i := range entries {
		if entries[i].Path == "tool thing remove" {
			entries[i].Destructive = false
			entries[i].DryRun = ""
		}
	}
	NewRegistry(testGroups, entries).Apply(root, allOn)

	remove := find(t, root, "thing", "remove")
	if _, set := remove.Annotations[AnnotationDestructive]; set {
		t.Error("the destructive annotation outlived the entry that set it")
	}
	if _, set := remove.Annotations[AnnotationDryRun]; set {
		t.Error("the dry-run annotation outlived the entry that set it")
	}
}

func TestApply_DecidesWhatIsListed(t *testing.T) {
	root := testTree()
	entries := testEntries()
	for i := range entries {
		if entries[i].Path == "tool status" {
			entries[i].Hidden = true
		}
	}
	r := NewRegistry(testGroups, entries)

	r.Apply(root, allOff)
	for _, path := range [][]string{{"status"}, {"admin"}, {"thing", "east"}} {
		if !find(t, root, path...).Hidden {
			t.Errorf("%v is listed with every capability and cloud off", path)
		}
	}
	for _, path := range [][]string{{"thing"}, {"thing", "list"}, {"admin", "purge"}} {
		if find(t, root, path...).Hidden {
			t.Errorf("%v is hidden, and its own entry names no switch", path)
		}
	}

	// One of the command's two clouds is enough to list it.
	r.Apply(root, Options{
		Enabled:      func(capability string) bool { return capability == "admin" },
		CloudEnabled: func(slug string) bool { return slug == "far-east" },
	})
	if find(t, root, "admin").Hidden || find(t, root, "thing", "east").Hidden {
		t.Error("a command stayed hidden after its switch was turned on")
	}
	if !find(t, root, "status").Hidden {
		t.Error("a command its entry hides was listed")
	}
}

func TestApply_RegistersDryRunOnlyWhereTheEntryDeclaresIt(t *testing.T) {
	root := testTree()
	NewRegistry(testGroups, testEntries()).Apply(root, allOn)

	create := find(t, root, "thing", "create")
	flag := create.Flags().Lookup(DryRunFlag)
	if flag == nil || flag.Usage != dryRunUsage {
		t.Fatalf("create declares a dry run and has no --%s flag from the registry: %+v", DryRunFlag, flag)
	}
	if got := find(t, root, "thing", "remove").Flags().Lookup(DryRunFlag).Usage; got != "The command's own dry run" {
		t.Errorf("the command's own --%s was replaced: usage %q", DryRunFlag, got)
	}
	list := find(t, root, "thing", "list")
	if list.Flags().Lookup(DryRunFlag) != nil {
		t.Errorf("a command with no dry run was given --%s", DryRunFlag)
	}

	if DryRunRequested(list) {
		t.Error("DryRunRequested is true for a command without the flag")
	}
	if DryRunRequested(create) {
		t.Error("DryRunRequested is true before the flag is given")
	}
	if err := create.Flags().Set(DryRunFlag, "true"); err != nil {
		t.Fatal(err)
	}
	if !DryRunRequested(create) {
		t.Error("DryRunRequested is false after --dry-run")
	}
}

func TestApply_LeavesACommandWithNoEntryAlone(t *testing.T) {
	root := testTree()
	extra := &cobra.Command{Use: "extra", Example: "  tool extra", Hidden: true, Run: noop}
	root.AddCommand(extra)

	NewRegistry(testGroups, testEntries()).Apply(root, allOn)

	if extra.Example != "  tool extra" || !extra.Hidden || extra.GroupID != "" || extra.Annotations != nil {
		t.Errorf("Apply changed a command it has no entry for: %+v", extra)
	}
}

func TestCheck_ACompleteRegistryHasNoProblems(t *testing.T) {
	root := testTree()
	r := NewRegistry(testGroups, testEntries())
	r.Apply(root, allOn)
	if problems := r.Check(root); len(problems) != 0 {
		t.Errorf("Check reported problems on a registry that matches its tree:\n%s", strings.Join(problems, "\n"))
	}
}

func TestCheck_ReportsEveryDisagreement(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(entries []Meta, root *cobra.Command) []Meta
		want   string
	}{
		{
			name: "a path entered twice",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return append(entries, Meta{Path: "tool status", Group: "tool", Output: OutputTable})
			},
			want: `"tool status" has more than one entry`,
		},
		{
			name: "an entry for no command",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return append(entries, Meta{Path: "tool gone", Output: OutputTable})
			},
			want: `"tool gone" has an entry but no such command exists`,
		},
		{
			name: "a runnable command with no entry",
			mutate: func(entries []Meta, root *cobra.Command) []Meta {
				thing, _, _ := root.Find([]string{"thing"})
				thing.AddCommand(&cobra.Command{Use: "new", Run: noop})
				return entries
			},
			want: `"tool thing new" is runnable and has no entry`,
		},
		{
			name: "a top-level group with no entry",
			mutate: func(entries []Meta, root *cobra.Command) []Meta {
				root.AddCommand(&cobra.Command{Use: "shelf"})
				return entries
			},
			want: `"tool shelf" is listed in the root's help and has no entry to give it a help group`,
		},
		{
			name: "a runnable command with no output kind",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return replace(entries, "tool thing list", func(m *Meta) { m.Output = "" })
			},
			want: `"tool thing list" states output kind "" (want table, document, secret or none)`,
		},
		{
			name: "an unknown dry-run level",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return replace(entries, "tool thing list", func(m *Meta) { m.DryRun = "pretend" })
			},
			want: `"tool thing list" states dry-run level "pretend" (want none, client or server)`,
		},
		{
			name: "a top-level command with no help group",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return replace(entries, "tool status", func(m *Meta) { m.Group = "" })
			},
			want: `"tool status" is directly under the root and names no help group`,
		},
		{
			name: "a help group that is not registered",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return replace(entries, "tool status", func(m *Meta) { m.Group = "elsewhere" })
			},
			want: `"tool status" names help group "elsewhere", which is not registered`,
		},
		{
			name: "a help group below the top level",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return replace(entries, "tool thing list", func(m *Meta) { m.Group = "work" })
			},
			want: `"tool thing list" names a help group but is not directly under the root`,
		},
		{
			name: "destructive without mutating",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return replace(entries, "tool thing remove", func(m *Meta) { m.Mutates = false })
			},
			want: `"tool thing remove" is destructive or long-running but is not marked as mutating`,
		},
		{
			name: "long-running without mutating",
			mutate: func(entries []Meta, _ *cobra.Command) []Meta {
				return replace(entries, "tool thing create", func(m *Meta) { m.Mutates = false })
			},
			want: `"tool thing create" is destructive or long-running but is not marked as mutating`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := testTree()
			r := NewRegistry(testGroups, tc.mutate(testEntries(), root))
			r.Apply(root, allOn)
			problems := r.Check(root)
			if !slices.Contains(problems, tc.want) {
				t.Errorf("Check did not report %q; it reported:\n%s", tc.want, strings.Join(problems, "\n"))
			}
			if !slices.IsSorted(problems) {
				t.Errorf("the problems are not sorted: %v", problems)
			}
		})
	}
}

// replace returns entries with the entry at path changed by edit.
func replace(entries []Meta, path string, edit func(*Meta)) []Meta {
	for i := range entries {
		if entries[i].Path == path {
			edit(&entries[i])
		}
	}
	return entries
}

func TestDescribe_TheDocument(t *testing.T) {
	root := testTree()
	root.AddCommand(&cobra.Command{Use: "old", Deprecated: "use status", Run: noop})
	root.AddCommand(&cobra.Command{Use: "bare", Run: noop})
	r := NewRegistry(testGroups, testEntries())
	r.Apply(root, Options{Enabled: func(string) bool { return true }, CloudEnabled: func(slug string) bool { return slug == "east" }})

	doc := r.Describe(root)

	if doc.Schema != Schema || doc.Name != "tool" || doc.Version != "1.2.3" {
		t.Errorf("header = %q %q %q", doc.Schema, doc.Name, doc.Version)
	}
	if !slices.Equal(doc.Groups, testGroups) {
		t.Errorf("groups = %v", doc.Groups)
	}
	if len(doc.GlobalFlags) != 1 || doc.GlobalFlags[0] != (FlagDoc{Name: "output", Shorthand: "o", Type: "string", Default: "table", Usage: "Output format"}) {
		t.Errorf("global flags = %+v", doc.GlobalFlags)
	}

	byPath := map[string]CommandDoc{}
	var paths []string
	for _, c := range doc.Commands {
		byPath[c.Path] = c
		paths = append(paths, c.Path)
	}
	if !slices.IsSorted(paths) {
		t.Errorf("the commands are not sorted by path: %v", paths)
	}
	if _, ok := byPath["tool"]; ok {
		t.Error("the root is listed as one of its own commands")
	}
	if _, ok := byPath["tool old"]; ok {
		t.Error("a deprecated command is described")
	}

	thing := byPath["tool thing"]
	if thing.Runnable || thing.Group != "work" || thing.Output != OutputNone || !slices.Equal(thing.Aliases, []string{"things"}) {
		t.Errorf("the group command = %+v", thing)
	}

	list := byPath["tool thing list"]
	if !list.Runnable || list.Group != "work" || !list.Idempotent || list.Mutates || list.DryRun != DryRunNone || list.Output != OutputTable {
		t.Errorf("list = %+v", list)
	}
	if list.Use != "tool thing list [flags]" || list.Short != "List things" {
		t.Errorf("list use/short = %q / %q", list.Use, list.Short)
	}
	// Its own flag and the flag its parent hands down; not the global one, not the hidden one.
	var flags []string
	for _, f := range list.Flags {
		flags = append(flags, f.Name)
	}
	if !slices.Equal(flags, []string{"limit", "project"}) {
		t.Errorf("list flags = %v, want [limit project]", flags)
	}
	if len(list.Examples) != 2 || list.Examples[0].Note == "" {
		t.Errorf("list examples = %+v", list.Examples)
	}

	remove := byPath["tool thing remove"]
	if !remove.Mutates || !remove.Destructive || remove.DryRun != DryRunServer || remove.Long != "Removes one thing." {
		t.Errorf("remove = %+v", remove)
	}
	if east := byPath["tool thing east"]; !slices.Equal(east.Clouds, []string{"east", "far-east"}) {
		t.Errorf("east clouds = %v", east.Clouds)
	}

	// A capability named on a parent is the capability of everything below it.
	if byPath["tool admin"].Capability != "admin" || byPath["tool admin purge"].Capability != "admin" {
		t.Errorf("capability: admin=%q purge=%q", byPath["tool admin"].Capability, byPath["tool admin purge"].Capability)
	}
	if byPath["tool admin purge"].Group != "tool" {
		t.Errorf("a command below the top level is in group %q, want its ancestor's", byPath["tool admin purge"].Group)
	}

	// A command with no entry is described with the zero entry.
	bare, ok := byPath["tool bare"]
	if !ok || bare.Output != OutputNone || bare.DryRun != DryRunNone || bare.Group != "" {
		t.Errorf("a command with no entry = %+v, %v", bare, ok)
	}
}

func TestDescribe_LeavesOutWhatIsNotListed(t *testing.T) {
	root := testTree()
	r := NewRegistry(testGroups, testEntries())
	r.Apply(root, allOff)

	for _, c := range r.Describe(root).Commands {
		if strings.HasPrefix(c.Path, "tool admin") || c.Path == "tool thing east" {
			t.Errorf("%q is described although it is not listed", c.Path)
		}
	}
}

func TestDescribe_NoListIsEverNull(t *testing.T) {
	root := &cobra.Command{Use: "tool", Run: noop}
	root.AddCommand(&cobra.Command{Use: "one", Run: noop})
	r := NewRegistry(nil)
	root.CompletionOptions.DisableDefaultCmd = true

	raw, err := json.Marshal(r.Describe(root))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "null") {
		t.Errorf("the document carries a null: %s", raw)
	}
	for _, key := range []string{`"groups":[]`, `"global_flags":[]`, `"aliases":[]`, `"flags":[]`, `"examples":[]`, `"clouds":[]`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("the document does not carry %s: %s", key, raw)
		}
	}
}

func TestWriteManPages_OnePagePerListedCommand(t *testing.T) {
	root := testTree()
	NewRegistry(testGroups, testEntries()).Apply(root, allOff)
	dir := t.TempDir()

	if err := WriteManPages(root, dir); err != nil {
		t.Fatalf("WriteManPages: %v", err)
	}

	page, err := os.ReadFile(filepath.Join(dir, "tool-thing-list.1"))
	if err != nil {
		t.Fatalf("no page for a listed command: %v", err)
	}
	for _, want := range []string{`.TH "TOOL-THING-LIST" "1"`, "tool thing list --limit 5", "tool 1.2.3"} {
		if !strings.Contains(string(page), want) {
			t.Errorf("the page does not contain %q:\n%s", want, page)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "tool-admin.1")); !os.IsNotExist(err) {
		t.Errorf("a command that is not listed got a page (stat error: %v)", err)
	}

	if err := WriteManPages(root, filepath.Join(dir, "missing")); err == nil {
		t.Error("writing into a directory that does not exist reported no error")
	}
}
