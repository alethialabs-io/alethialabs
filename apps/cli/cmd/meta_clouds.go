// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaClouds is the registry's entries for the clouds family: connecting cloud accounts and inspecting what they hold.
//
// Every runnable command of the family is listed with its facts and its examples. What each field
// means is documented once, on cmdmeta.Meta. TestMeta_TheRegistryAndTheTreeAgree fails on a
// runnable command with no entry.
var metaClouds = []cmdmeta.Meta{
	{Path: "alethia connector", Group: groupDeploy},
	{
		Path: "alethia connector list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia connector list", Note: "The connected cloud accounts of the active organization"},
			{Cmd: "alethia connector list --output json", Note: "The full records, with each connection's id"},
		},
	},
	// Each connector opens a pending identity and then creates the cloud-side access, so a second
	// run is not a repeat of the first: none of them is idempotent.
	{
		Path: "alethia connector aws", Mutates: true, DryRun: cmdmeta.DryRunClient,
		Clouds: []string{"aws"}, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia connector aws --region eu-west-1", Note: "Deploy the role with the local aws CLI"},
			{Cmd: "alethia connector aws --manual", Note: "Deploy from the AWS console and paste the role ARN"},
			{
				Cmd:  "alethia connector aws --no-input --role-arn arn:aws:iam::123456789012:role/AlethiaProvisionerRole",
				Note: "Submit a role that already exists, from a script",
			},
		},
	},
	{
		Path: "alethia connector gcp", Mutates: true, DryRun: cmdmeta.DryRunClient,
		Clouds: []string{"gcp"}, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia connector gcp --project my-gcp-project", Note: "Run the installer in your Google Cloud Shell"},
			{Cmd: "alethia connector gcp --project my-gcp-project --manual", Note: "Run it in the browser Cloud Shell and paste the result"},
			{
				Cmd:  "alethia connector gcp --no-input --project my-gcp-project --wif-config ./wif.json",
				Note: "Submit a credential config that already exists, from a script",
			},
		},
	},
	{
		Path: "alethia connector azure", Mutates: true, DryRun: cmdmeta.DryRunClient,
		Clouds: []string{"azure"}, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{
				Cmd:  "alethia connector azure --subscription 00000000-0000-0000-0000-000000000000",
				Note: "Create the managed identity with the local az CLI",
			},
			{
				Cmd: "alethia connector azure --no-input --subscription 00000000-0000-0000-0000-000000000000 " +
					"--tenant-id 11111111-1111-1111-1111-111111111111 --client-id 22222222-2222-2222-2222-222222222222",
				Note: "Submit a managed identity that already exists, from a script",
			},
		},
	},
	{
		Path: "alethia connector hetzner", Mutates: true, DryRun: cmdmeta.DryRunClient,
		Clouds: []string{"hetzner"}, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia connector hetzner", Note: "Type the token at a masked prompt"},
			{Cmd: `echo "$HCLOUD_TOKEN" | alethia connector hetzner --no-input --token-stdin`, Note: "From a pipe, for scripts and CI"},
		},
	},
	{
		Path: "alethia connector alibaba", Mutates: true, DryRun: cmdmeta.DryRunClient,
		Clouds: []string{"alibaba"}, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia connector alibaba", Note: "Create the role with the local aliyun CLI"},
			{
				Cmd:  "alethia connector alibaba --no-input --role-arn acs:ram::123456789012:role/AlethiaProvisioner",
				Note: "Submit a role that already exists, from a script",
			},
		},
	},
	// A second run finds the account already gone and reports that; it removes nothing more.
	{
		Path: "alethia connector remove", Mutates: true, Destructive: true, Idempotent: true,
		DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia connector remove", Note: "Choose the account from a picker"},
			{Cmd: "alethia connector remove gcp --dry-run", Note: "Show which account would be disconnected"},
			{Cmd: "alethia connector remove gcp --yes", Note: "Disconnect without the question, from a script"},
		},
	},
	{Path: "alethia provider", Group: groupInspect},
	{
		Path: "alethia provider status", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia provider status aws", Note: "Whether AWS is connected, and as which role"},
			{Cmd: "alethia provider status", Note: "Choose a connected account from a picker"},
		},
	},
	// Re-runs the health probe and records its result on the identity.
	{
		Path: "alethia provider verify", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia provider verify aws", Note: "Probe the AWS connection again after changing the role"},
			{Cmd: "alethia provider verify azure --output json", Note: "The verdict as a result object"},
		},
	},
	{Path: "alethia cloud", Group: groupInspect},
	{
		Path: "alethia cloud inventory", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia cloud inventory aws", Note: "The networks, subnets and regions of the connected AWS account"},
			{Cmd: "alethia cloud inventory", Note: "Choose a connected account from a picker"},
			{Cmd: "alethia cloud inventory gcp --output csv", Note: "The networks as rows"},
		},
	},
}
