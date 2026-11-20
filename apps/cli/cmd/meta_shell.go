// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaShell is the registry's entries for the shell: the root command and the first-run verbs hanging directly off it.
//
// Every runnable command of the family is listed with its facts filled in and at least one
// example. What each field means is documented once, on cmdmeta.Meta.
// TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no entry.
var metaShell = []cmdmeta.Meta{
	// A bare `alethia` prints the banner and the help.
	{
		Path: "alethia", Idempotent: true, Output: cmdmeta.OutputNone,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia", Note: "The banner and every command, grouped"},
			{Cmd: "alethia up --help", Note: "What one command does, with its flags and examples"},
		},
	},
	// Signs in, writes alethia.yaml, creates the project and queues one deploy per environment.
	// Not idempotent in the registry's sense: a second run changes nothing in the project and
	// still queues the deploys again.
	{
		Path: "alethia up", Group: groupStart, Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia up", Note: "The guided first run: every missing value is asked for"},
			{
				Cmd:  "alethia up --no-input --yes --project boutique --region nbg1 --cloud-account prod-account",
				Note: "The same run with no terminal: writes alethia.yaml, then deploys it",
			},
			{Cmd: "alethia up --yes --no-wait --output json", Note: "Queue the deploys and print the job ids as one document"},
		},
	},
	// Writes the CLI's own configuration and, when this directory has none, alethia.yaml; it may
	// also sign in. A second run with the same input finds all three done and changes nothing.
	{
		Path: "alethia init", Group: groupStart, Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia init", Note: "The guided setup: the control-plane URL, the sign-in, the manifest"},
			{
				Cmd:  "alethia init --no-input --project boutique --region nbg1 --cloud-account prod-account",
				Note: "Write alethia.yaml with no terminal, on a machine that is already signed in",
			},
			{
				Cmd:  "alethia init --no-input --skip-manifest --web-origin https://alethia.internal.example.com",
				Note: "Point the CLI at a self-hosted control plane and write no manifest",
			},
		},
	},
	// Reads the build facts and asks the control plane for the newest release. Nothing is written.
	{
		Path: "alethia version", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia version", Note: "The release, the commit it was built from and that commit's date"},
			{Cmd: "alethia version --output json", Note: "The same facts as one document, for a script or a bug report"},
		},
	},
	// Replaces the CLI's own binary. Already being on the latest release changes nothing.
	{
		Path: "alethia update", Group: groupSettings, Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia update", Note: "Install the newest release through the channel this CLI came from"},
			{Cmd: "alethia update --output json", Note: "The same update, reported as one document: from, to, the channel, and whether it changed"},
		},
	},
	// Opens a browser, or prints the URL. Nothing is written anywhere.
	{
		Path: "alethia open", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia open", Note: "The active organization's page in the console"},
			{Cmd: "alethia open docs", Note: "The documentation"},
			{Cmd: "alethia open --project boutique --print", Note: "Print one project's console URL and open nothing"},
		},
	},
}
