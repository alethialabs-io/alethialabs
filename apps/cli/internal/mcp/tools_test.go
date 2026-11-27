// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
)

// fixtureDoc is a command description with one command per rule Select applies.
func fixtureDoc() cmdmeta.Document {
	table := cmdmeta.OutputTable
	cmd := func(path, group string, mutates, destructive bool, output cmdmeta.Output, flags ...cmdmeta.FlagDoc) cmdmeta.CommandDoc {
		return cmdmeta.CommandDoc{
			Path: path, Use: path + " [flags]", Short: "does " + path, Group: group, Runnable: true,
			Mutates: mutates, Destructive: destructive, Idempotent: !mutates, Output: output,
			Flags: append([]cmdmeta.FlagDoc{}, flags...),
		}
	}
	withArgs := cmd("alethia project get", "deploy", false, false, table,
		cmdmeta.FlagDoc{Name: "project", Type: "string", Usage: "Project"})
	withArgs.Use = "alethia project get <name> [flags]"
	return cmdmeta.Document{
		Schema: cmdmeta.Schema,
		Name:   "alethia",
		GlobalFlags: []cmdmeta.FlagDoc{
			{Name: "output", Type: "string"}, {Name: "token", Type: "string"}, {Name: "org", Type: "string", Usage: "Organization"},
			{Name: "agent", Type: "string"}, {Name: "no-input", Type: "bool"}, {Name: "debug", Type: "bool"},
		},
		Commands: []cmdmeta.CommandDoc{
			{Path: "alethia project", Group: "deploy", Output: cmdmeta.OutputNone},
			withArgs,
			cmd("alethia project create", "deploy", true, false, table),
			cmd("alethia project destroy", "deploy", true, true, table, cmdmeta.FlagDoc{Name: "yes", Type: "bool"}),
			cmd("alethia approve", "deploy", false, false, table),
			cmd("alethia ops approve", "organization", true, false, table),
			cmd("alethia members list", "organization", false, false, table),
			cmd("alethia members add", "organization", true, false, table),
			cmd("alethia connector list", "deploy", false, false, table),
			cmd("alethia connector aws", "deploy", true, false, table),
			cmd("alethia connector hetzner", "deploy", true, false, table, cmdmeta.FlagDoc{Name: "token-stdin", Type: "bool"}),
			cmd("alethia fleet set", "deploy", true, false, table),
			cmd("alethia cluster token", "inspect", true, false, cmdmeta.OutputSecret),
			cmd("alethia jobs logs", "inspect", false, false, cmdmeta.OutputDocument,
				cmdmeta.FlagDoc{Name: "follow", Type: "bool"}, cmdmeta.FlagDoc{Name: "out", Type: "string"}),
			cmd("alethia config set", "settings", true, false, table),
			cmd("alethia whoami", "settings", false, false, table),
			cmd("alethia login", "start", true, false, table),
			cmd("alethia help", "settings", false, false, cmdmeta.OutputNone),
			cmd("alethia mcp", "settings", false, false, cmdmeta.OutputDocument),
		},
	}
}

// names returns the tools' names.
func names(tools []Tool) []string {
	out := make([]string, len(tools))
	for i, t := range tools {
		out[i] = t.Name
	}
	return out
}

func TestSelect_EachToolSetOffersExactlyItsCommands(t *testing.T) {
	doc := fixtureDoc()
	cases := map[ToolSet][]string{
		ToolSetReadOnly:    {"project_get", "members_list", "connector_list", "jobs_logs"},
		ToolSetStandard:    {"project_get", "project_create", "members_list", "connector_list", "jobs_logs"},
		ToolSetDestructive: {"project_get", "project_create", "project_destroy", "members_list", "connector_list", "jobs_logs"},
	}
	for set, want := range cases {
		if got := names(Select(doc, set)); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v", set, got, want)
		}
	}
}

func TestSelect_NoToolSetOffersAnApproveTool(t *testing.T) {
	for _, set := range ToolSets {
		for _, tool := range Select(fixtureDoc(), set) {
			if strings.HasSuffix(tool.Name, "approve") {
				t.Errorf("%s offers %s", set, tool.Name)
			}
		}
	}
	// The rule, not the group, is what refuses it: `approve` is a non-mutating deploy command,
	// which every other rule would let through.
	for _, c := range fixtureDoc().Commands {
		if c.Path == "alethia approve" && !strings.Contains(Excluded(c), "no tool approves") {
			t.Errorf("alethia approve is excluded for %q, want the approval rule", Excluded(c))
		}
	}
}

func TestExcluded_SaysWhyForEachRule(t *testing.T) {
	want := map[string]string{
		"alethia project":           "only holds subcommands",
		"alethia ops approve":       "no tool approves",
		"alethia connector hetzner": "takes a secret",
		"alethia cluster token":     "prints a credential",
		"alethia config set":        "the CLI itself",
		"alethia login":             "the CLI itself",
		"alethia help":              "the CLI itself",
		"alethia mcp":               "the CLI itself",
		"alethia project get":       "",
	}
	for _, c := range fixtureDoc().Commands {
		w, ok := want[c.Path]
		if !ok {
			continue
		}
		got := Excluded(c)
		if (w == "") != (got == "") || !strings.Contains(got, w) {
			t.Errorf("%s: Excluded = %q, want it to contain %q", c.Path, got, w)
		}
	}
}

func TestSelect_AnnotationsComeFromTheRegistry(t *testing.T) {
	tools := Select(fixtureDoc(), ToolSetDestructive)
	byName := map[string]Tool{}
	for _, tool := range tools {
		byName[tool.Name] = tool
	}
	if a := byName["project_get"].Annotations; a != (Annotations{ReadOnlyHint: true, IdempotentHint: true, OpenWorldHint: true}) {
		t.Errorf("project_get annotations = %+v", a)
	}
	if a := byName["project_destroy"].Annotations; a != (Annotations{DestructiveHint: true, OpenWorldHint: true}) {
		t.Errorf("project_destroy annotations = %+v", a)
	}
	if got := byName["project_get"].Title; got != "alethia project get" {
		t.Errorf("title = %q", got)
	}
}

func TestSelect_FlagsLeaveOutWhatOnlyTheServerDecides(t *testing.T) {
	tool := Select(fixtureDoc(), ToolSetReadOnly)[3]
	if tool.Name != "jobs_logs" {
		t.Fatalf("fixture order changed: %s", tool.Name)
	}
	var got []string
	for name := range tool.Flags {
		got = append(got, name)
	}
	slices.Sort(got)
	// follow and out are hidden; of the globals only org is offered.
	if want := []string{"org"}; !reflect.DeepEqual(got, want) {
		t.Errorf("flags = %v, want %v", got, want)
	}
}

func TestInputSchema_TypesEachFlagAndClosesTheObject(t *testing.T) {
	tool := Tool{
		Flags: map[string]cmdmeta.FlagDoc{
			"yes": {Name: "yes", Type: "bool"}, "limit": {Name: "limit", Type: "int"},
			"set": {Name: "set", Type: "stringArray"}, "timeout": {Name: "timeout", Type: "duration"},
			"ratio": {Name: "ratio", Type: "float64"},
		},
		TakesArgs: true, ArgsUsage: "<name>",
	}
	s := tool.InputSchema()
	if s["type"] != "object" || s["additionalProperties"] != false {
		t.Fatalf("root = %v", s)
	}
	props, _ := s["properties"].(map[string]any)
	want := map[string]string{"yes": "boolean", "limit": "integer", "set": "array", "timeout": "string", "ratio": "number", "args": "array"}
	for name, typ := range want {
		p, _ := props[name].(map[string]any)
		if p["type"] != typ {
			t.Errorf("%s: type %v, want %s", name, p["type"], typ)
		}
	}
	if len(props) != len(want) {
		t.Errorf("properties = %v", props)
	}
}

func TestArgv_FlagsAsNameEqualsValueThenArgsAfterTheDashes(t *testing.T) {
	tool := Tool{
		Command: []string{"project", "get"},
		Flags: map[string]cmdmeta.FlagDoc{
			"yes": {Type: "bool"}, "limit": {Type: "int"}, "set": {Type: "stringArray"}, "project": {Type: "string"},
		},
		TakesArgs: true,
	}
	got, err := tool.Argv(json.RawMessage(`{"project":"-x","limit":3,"yes":true,"set":["a=1","b=2"],"args":["--web-origin=https://elsewhere","shop"]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"project", "get", "--limit=3", "--project=-x", "--set=a=1", "--set=b=2", "--yes=true",
		"--", "--web-origin=https://elsewhere", "shop"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %q\nwant   %q", got, want)
	}
}

func TestArgv_RefusesWhatTheToolDoesNotDeclare(t *testing.T) {
	tool := Tool{Command: []string{"jobs", "list"}, Flags: map[string]cmdmeta.FlagDoc{"limit": {Type: "int"}}}
	for _, raw := range []string{
		`{"token":"secret"}`, // a hidden global flag
		`{"args":["x"]}`,     // a command with no positional arguments
		`{"limit":1.5}`,      // not a whole number
		`{"limit":"3"}`,      // not a number at all
		`["limit"]`,          // not an object
	} {
		if argv, err := tool.Argv(json.RawMessage(raw)); err == nil {
			t.Errorf("%s: accepted as %q", raw, argv)
		}
	}
	if argv, err := tool.Argv(nil); err != nil || !reflect.DeepEqual(argv, []string{"jobs", "list"}) {
		t.Errorf("no arguments: %q, %v", argv, err)
	}
	if argv, err := tool.Argv(json.RawMessage(`{"limit":null}`)); err != nil || len(argv) != 2 {
		t.Errorf("a null flag: %q, %v", argv, err)
	}
}

func TestParseToolSet_KnowsEachNameAndNothingElse(t *testing.T) {
	for _, set := range ToolSets {
		if got, ok := ParseToolSet(string(set)); !ok || got != set {
			t.Errorf("ParseToolSet(%q) = %q, %v", set, got, ok)
		}
	}
	if _, ok := ParseToolSet("all"); ok {
		t.Error("ParseToolSet accepted all")
	}
}

func TestFlagValues_WritesEachKindAndRefusesTheWrongShape(t *testing.T) {
	ok := []struct {
		kind valueKind
		raw  string
		want []string
	}{
		{kindNumber, `0.5`, []string{"0.5"}},
		{kindInt, `-3`, []string{"-3"}},
		{kindList, `[]`, []string{}},
		{kindString, `"10m"`, []string{"10m"}},
		{kindBool, `false`, []string{"false"}},
	}
	for _, c := range ok {
		got, err := flagValues(c.kind, json.RawMessage(c.raw))
		if err != nil || (len(got) != 0 || len(c.want) != 0) && !reflect.DeepEqual(got, c.want) {
			t.Errorf("flagValues(%d, %s) = %q, %v", c.kind, c.raw, got, err)
		}
	}
	for _, c := range []struct {
		kind valueKind
		raw  string
	}{{kindNumber, `"x"`}, {kindList, `"a"`}, {kindString, `3`}, {kindBool, `"yes"`}} {
		if got, err := flagValues(c.kind, json.RawMessage(c.raw)); err == nil {
			t.Errorf("flagValues(%d, %s) accepted as %q", c.kind, c.raw, got)
		}
	}
}
