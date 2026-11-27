// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// The command registry of this CLI: the help groups, and one entry per command.
//
// The entries live beside this file, one file per command family (meta_<family>.go), so the lane
// that owns a family's commands owns its entries too and two lanes never edit the same list. This
// file joins them, and is the only place that knows the whole set.

// The help groups, by id. A top-level command names one of these in its entry.
const (
	groupStart        = "start"
	groupDeploy       = "deploy"
	groupInspect      = "inspect"
	groupOrganization = "organization"
	groupSettings     = "settings"
)

// helpGroups are the headings of the root's help, in the order they are printed: the way in first,
// then what the CLI is for, then what it can tell you, then who may do what, then the CLI itself.
var helpGroups = []cmdmeta.Group{
	{ID: groupStart, Title: "Start here:"},
	{ID: groupDeploy, Title: "Deploy:"},
	{ID: groupInspect, Title: "Inspect:"},
	{ID: groupOrganization, Title: "Organization:"},
	{ID: groupSettings, Title: "Settings:"},
}

// commandRegistry builds the registry from every family's entries.
func commandRegistry() *cmdmeta.Registry {
	return cmdmeta.NewRegistry(helpGroups,
		metaShell,
		metaAuth,
		metaManifest,
		metaProject,
		metaClouds,
		metaRunners,
		metaJobs,
		metaGovernance,
		metaReads,
		metaAgent,
		metaOps,
		metaBuiltin,
		metaMCP,
	)
}

// registryOptions are the answers the registry needs from this build: which capabilities are on
// and which clouds are offered (capabilities.go).
func registryOptions() cmdmeta.Options {
	return cmdmeta.Options{Enabled: Enabled, CloudEnabled: CloudEnabled}
}

// applyCommandMeta writes the registry onto the command tree: help groups, examples, annotations,
// and whether each command is listed. Execute calls it before the tree runs.
//
// It can be called again. A command's listing follows the capabilities as they are at the time of
// the call, so a test that switches one on applies again and sees the command appear.
func applyCommandMeta() {
	commandRegistry().Apply(rootCmd, registryOptions())
}

// describeCommands returns the versioned description of every listed command, with its flags and
// its registry entry. It is the document a machine reads to learn the CLI.
func describeCommands() cmdmeta.Document {
	applyCommandMeta()
	return commandRegistry().Describe(rootCmd)
}
