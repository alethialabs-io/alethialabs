// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// reapplyMetaAfter registers a re-application of the registry as the LAST cleanup of the test, so
// it runs after the environment the test changed has been put back and the tree other tests see is
// the default one. Call it before changing the environment.
func reapplyMetaAfter(t *testing.T) {
	t.Helper()
	t.Cleanup(applyCommandMeta)
}

// helpOf returns the help text of one command of the tree.
func helpOf(t *testing.T, cmd *cobra.Command) string {
	t.Helper()
	var out bytes.Buffer
	rootCmd.SetOut(&out)
	t.Cleanup(func() { rootCmd.SetOut(nil) })
	if err := cmd.Help(); err != nil {
		t.Fatalf("help: %v", err)
	}
	rootCmd.SetOut(nil)
	return out.String()
}

// TestMeta_TheRegistryAndTheTreeAgree is the hygiene test of the registry: every runnable command
// has an entry, every entry names a command, every top-level command has a help group, and every
// entry is well formed. A command added without an entry fails here.
func TestMeta_TheRegistryAndTheTreeAgree(t *testing.T) {
	applyCommandMeta()
	registry := commandRegistry()
	for _, problem := range registry.Check(rootCmd) {
		t.Error(problem)
	}

	// The check is only worth its silence if it walked the real tree. These are one per family
	// file, so a family dropped from commandRegistry is noticed whatever Check says.
	for _, path := range []string{
		"alethia", "alethia up", "alethia login", "alethia apply", "alethia project list",
		"alethia connector aws", "alethia runner deploy", "alethia jobs logs", "alethia members add",
		"alethia chart scan", "alethia agent list", "alethia ops retry-job", "alethia completion bash",
	} {
		if _, ok := registry.Lookup(path); !ok {
			t.Errorf("the registry has no entry for %q", path)
		}
	}
	if n := len(registry.Paths()); n < 150 {
		t.Errorf("the registry holds %d entries; the tree has more than 150 commands", n)
	}
}

// TestMeta_ACommandWithNoEntryIsReported proves the hygiene test can fail: a runnable command
// added to the live tree with no entry is named by Check.
func TestMeta_ACommandWithNoEntryIsReported(t *testing.T) {
	stray := &cobra.Command{Use: "stray-for-test", Run: func(*cobra.Command, []string) {}}
	rootCmd.AddCommand(stray)
	t.Cleanup(func() { rootCmd.RemoveCommand(stray) })

	applyCommandMeta()
	want := `"alethia stray-for-test" is runnable and has no entry`
	if problems := commandRegistry().Check(rootCmd); !slices.Contains(problems, want) {
		t.Errorf("Check did not report the stray command; it reported %v", problems)
	}
}

// TestMeta_EveryCapabilityNamedIsKnown holds the entries to the capability list. Enabled answers
// no for a name it does not know, so a misspelt capability would hide its command for good.
func TestMeta_EveryCapabilityNamedIsKnown(t *testing.T) {
	registry := commandRegistry()
	named := 0
	for _, path := range registry.Paths() {
		m, _ := registry.Lookup(path)
		if m.Capability == "" {
			continue
		}
		named++
		if _, known := capabilityEnv[m.Capability]; !known {
			t.Errorf("%q names capability %q, which capabilities.go does not define", path, m.Capability)
		}
	}
	if named == 0 {
		t.Error("no entry names a capability, so this test checked nothing")
	}
}

// TestMeta_EveryCloudNamedIsACloudProvider holds the entries to the cloud_provider enum, for the
// same reason: a cloud the catalog has never heard of is never offered.
func TestMeta_EveryCloudNamedIsACloudProvider(t *testing.T) {
	registry := commandRegistry()
	named := 0
	for _, path := range registry.Paths() {
		m, _ := registry.Lookup(path)
		for _, slug := range m.Clouds {
			named++
			if !slices.Contains(types.AllCloudProviders, types.CloudProvider(slug)) {
				t.Errorf("%q names cloud %q, which is not a cloud_provider value", path, slug)
			}
		}
	}
	if named == 0 {
		t.Error("no entry names a cloud, so this test checked nothing")
	}
}

// TestMeta_RootHelpIsGrouped pins the shape of `alethia --help`: the five headings in order, each
// command under its heading, and no command left in an unnamed remainder.
func TestMeta_RootHelpIsGrouped(t *testing.T) {
	applyCommandMeta()
	help := helpOf(t, rootCmd)

	last := -1
	for _, g := range helpGroups {
		at := strings.Index(help, "\n"+g.Title+"\n")
		if at < 0 {
			t.Fatalf("the help has no %q heading:\n%s", g.Title, help)
		}
		if at < last {
			t.Errorf("%q is printed out of order", g.Title)
		}
		last = at
	}
	if strings.Contains(help, "Additional Commands:") || strings.Contains(help, "Available Commands:") {
		t.Errorf("a command is listed outside the help groups:\n%s", help)
	}

	section := func(title string) string {
		rest := help[strings.Index(help, "\n"+title+"\n")+len(title)+2:]
		if end := strings.Index(rest, "\n\n"); end >= 0 {
			rest = rest[:end]
		}
		return rest
	}
	for title, commands := range map[string][]string{
		"Start here:":   {"up", "init", "login"},
		"Deploy:":       {"plan", "apply", "export", "project", "runner", "connector"},
		"Inspect:":      {"cluster", "jobs", "verify", "cost", "drift"},
		"Organization:": {"members", "teams", "roles", "token", "org"},
		"Settings:":     {"config", "version", "update", "help", "completion"},
	} {
		body := section(title)
		for _, name := range commands {
			if !strings.Contains(body, "\n  "+name+" ") && !strings.HasPrefix(body, "  "+name+" ") {
				t.Errorf("%q is not listed under %q:\n%s", name, title, body)
			}
		}
	}
}

// TestMeta_RootHelpNamesTheOfferedClouds pins the sentence the root's help opens with to the
// offered set, in both states of the switch that widens it.
func TestMeta_RootHelpNamesTheOfferedClouds(t *testing.T) {
	t.Setenv(catalog.HiddenCloudsEnv, "")
	if got := rootLong(); !strings.Contains(got, "across\nAWS, GCP, Azure and Hetzner from the terminal.") {
		t.Errorf("the root's description does not name the four offered clouds: %q", got)
	}
	if strings.Contains(rootCmd.Long, "Alibaba") {
		t.Errorf("the root's help names a cloud that is not offered: %q", rootCmd.Long)
	}

	t.Setenv(catalog.HiddenCloudsEnv, "alibaba")
	if got := rootLong(); !strings.Contains(got, "AWS, GCP, Azure, Alibaba and Hetzner") {
		t.Errorf("a re-enabled cloud is missing from the description: %q", got)
	}
}

// TestMeta_OpsIsListedOnlyWhenEnabled pins the ops switch end to end: off by default, on with the
// environment variable, and off again when it goes.
func TestMeta_OpsIsListedOnlyWhenEnabled(t *testing.T) {
	reapplyMetaAfter(t)

	applyCommandMeta()
	if !opsCmd.Hidden {
		t.Error("ops is listed with the capability off")
	}
	if help := helpOf(t, rootCmd); strings.Contains(help, "\n  ops ") {
		t.Errorf("the default help lists ops:\n%s", help)
	}
	for _, c := range describeCommands().Commands {
		if strings.HasPrefix(c.Path, "alethia ops") {
			t.Errorf("%q is described with the capability off", c.Path)
		}
	}

	modeEnv(t, map[string]string{OpsEnv: "1"})
	applyCommandMeta()
	if opsCmd.Hidden {
		t.Error("ops is hidden with the capability on")
	}
	if help := helpOf(t, rootCmd); !strings.Contains(help, "\n  ops ") {
		t.Errorf("the help does not list ops with the capability on:\n%s", help)
	}
	described := false
	for _, c := range describeCommands().Commands {
		if c.Path == "alethia ops retry-job" {
			described = c.Capability == CapabilityOps && c.Group == groupOrganization
		}
	}
	if !described {
		t.Error("an ops command is not described under its capability and its parent's group")
	}
}

// TestMeta_ACloudSpecificCommandFollowsTheOfferedSet pins that a command for one cloud is listed
// exactly when that cloud is offered.
func TestMeta_ACloudSpecificCommandFollowsTheOfferedSet(t *testing.T) {
	reapplyMetaAfter(t)

	t.Setenv(catalog.HiddenCloudsEnv, "")
	applyCommandMeta()
	if !connectorAlibabaCmd.Hidden {
		t.Error("the connector of a cloud that is not offered is listed")
	}
	help := helpOf(t, connectorCmd)
	if strings.Contains(help, "\n  alibaba ") {
		t.Errorf("`connector --help` lists a cloud that is not offered:\n%s", help)
	}
	for _, offered := range []string{"aws", "gcp", "azure", "hetzner"} {
		if !strings.Contains(help, "\n  "+offered+" ") {
			t.Errorf("`connector --help` does not list %s:\n%s", offered, help)
		}
	}

	t.Setenv(catalog.HiddenCloudsEnv, "alibaba")
	applyCommandMeta()
	if connectorAlibabaCmd.Hidden {
		t.Error("the connector of a re-enabled cloud is hidden")
	}
}

// TestMeta_ApplyKeepsTheAnnotationsCommandsSetThemselves pins that the registry's annotations sit
// beside a command's own, not in place of them.
func TestMeta_ApplyKeepsTheAnnotationsCommandsSetThemselves(t *testing.T) {
	applyCommandMeta()
	if versionCmd.Annotations[skipUpdateNoticeAnnotation] != "true" {
		t.Error("applying the registry removed the update-notice annotation from `version`")
	}
	if versionCmd.Annotations[cmdmeta.AnnotationOutput] != string(cmdmeta.OutputTable) {
		t.Errorf("`version` carries no output annotation: %v", versionCmd.Annotations)
	}
}

// TestMeta_TheDescriptionIsOneVersionedDocument pins the document a machine reads: its schema, the
// global flags, a command with its facts, and that it serialises with no null in it.
func TestMeta_TheDescriptionIsOneVersionedDocument(t *testing.T) {
	doc := describeCommands()

	if doc.Schema != "alethia.commands/v1" || doc.Name != "alethia" {
		t.Errorf("schema=%q name=%q", doc.Schema, doc.Name)
	}
	var globals []string
	for _, f := range doc.GlobalFlags {
		globals = append(globals, f.Name)
	}
	if want := []string{"agent", "debug", "no-input", "org", "output", "token"}; !slices.Equal(globals, want) {
		t.Errorf("global flags = %v, want %v", globals, want)
	}

	byPath := map[string]cmdmeta.CommandDoc{}
	for _, c := range doc.Commands {
		byPath[c.Path] = c
	}
	destroy, ok := byPath["alethia project destroy"]
	if !ok || !destroy.Mutates || !destroy.Destructive || !destroy.LongRunning || destroy.Idempotent ||
		destroy.Group != groupDeploy || destroy.Output != cmdmeta.OutputTable {
		t.Errorf("project destroy = %+v (found %v)", destroy, ok)
	}
	if !slices.ContainsFunc(destroy.Flags, func(f cmdmeta.FlagDoc) bool { return f.Name == "yes" }) {
		t.Errorf("project destroy is described without its --yes flag: %+v", destroy.Flags)
	}
	if slices.ContainsFunc(destroy.Flags, func(f cmdmeta.FlagDoc) bool { return f.Name == "output" }) {
		t.Error("a global flag is repeated among a command's own")
	}
	if design := byPath["alethia project design apply"]; design.DryRun != cmdmeta.DryRunServer {
		t.Errorf("project design apply dry run = %q", design.DryRun)
	}
	if token := byPath["alethia token create"]; token.Output != cmdmeta.OutputSecret {
		t.Errorf("token create output = %q", token.Output)
	}

	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), ":null") {
		t.Error("the document carries a null")
	}
}
