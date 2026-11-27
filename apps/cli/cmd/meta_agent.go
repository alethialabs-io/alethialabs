// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaAgent is the registry's entries for agent identities.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaAgent = []cmdmeta.Meta{
	{Path: "alethia agent", Group: groupOrganization},
	{
		Path: "alethia agent list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia agent list", Note: "The agent identities you can see"},
			{Cmd: "alethia agent list -o json", Note: "The same list, for a script"},
		},
	},
	{
		Path: "alethia agent get", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia agent get", Note: "Pick an agent identity from a list and show it"},
		},
	},
	{
		Path: "alethia agent setup", Mutates: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia agent setup", Note: "Configure the agents found on this machine; on a terminal you choose"},
			{Cmd: "alethia agent setup --client claude-code --client codex --project boutique", Note: "Two agents, pinned to one project"},
			{Cmd: "alethia agent setup --client cursor --read-only --dry-run", Note: "See what would be written, with only the tools that change nothing"},
		},
	},
	// The approval a CLI deploy or destroy waits for is decided in the console. approve opens that
	// page and sends nothing to the control plane.
	{
		Path: "alethia approve", Group: groupDeploy, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia approve 6b21d8f4-0c5e-4a93-9f27-3d81b6e5c704", Note: "Open the page where a person approves the deploy that printed this id"},
			{Cmd: "alethia approve 6b21d8f4-0c5e-4a93-9f27-3d81b6e5c704 --no-browser", Note: "Print the page instead, to send to the person who approves"},
		},
	},
}
