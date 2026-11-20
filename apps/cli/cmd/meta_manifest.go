// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaManifest is the registry's entries for the manifest verbs: alethia.yaml in, alethia.yaml out, and the CLI's own configuration.
//
// Every runnable command of the family is listed with its facts and its examples. What each field
// means is documented once, on cmdmeta.Meta. The facts were checked against the command bodies:
// TestMetaManifest_TheFactsMatchTheCommands holds the ones a test can read off the tree, and
// TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no entry.
//
// The examples use literal names — a project called boutique, an environment called prod — so
// each one can be run as written against a project of that name. None carries a value that has to
// be copied out of another command's output.
var metaManifest = []cmdmeta.Meta{
	// The dry run of `apply`: it reads and compares, and its exit code says what it found.
	{
		Path: "alethia plan", Group: groupDeploy, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia plan", Note: "Compare alethia.yaml in this directory with what exists"},
			{Cmd: "alethia plan --file envs/alethia.yaml --output json", Note: "Another file, as a typed plan for a program"},
			{Cmd: "alethia plan --detailed-exitcode", Note: "In a pipeline: exit 2 when there is something to apply, 3 when apply would refuse the file"},
		},
	},
	// Every run queues a deploy for each environment, so a second run is a second deploy. It
	// creates and updates and never removes, so it is not destructive; `plan` is its dry run, so
	// it has no --dry-run of its own.
	{
		Path: "alethia apply", Group: groupDeploy, Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia apply", Note: "Show the plan, ask once, then create what is missing and deploy every environment"},
			{Cmd: "alethia apply --yes --timeout 45m --output json", Note: "From a script: no question, wait at most 45 minutes, and read every job from the result"},
			{Cmd: "alethia apply --env dev-1 --runner primary --yes --no-wait", Note: "Deploy one environment on a named runner and return as soon as it is queued"},
		},
	},
	// Reads only. The file it writes is its output, not a mutation.
	{
		Path: "alethia export", Group: groupDeploy, Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia export boutique --all --out alethia.yaml", Note: "Write every environment of a project to a file"},
			{Cmd: "alethia export boutique --env prod", Note: "Print one environment's alethia.yaml on stdout"},
			{Cmd: "alethia export boutique --env prod --format console-json --out prod.json", Note: "The console's design document for one environment, as JSON"},
		},
	},
	// Reads local files only: nothing is sent.
	{
		Path: "alethia config", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia config", Note: "Which control plane and organization the CLI is using, and where its files are"},
			{Cmd: "alethia config --output json", Note: "The same for a program"},
		},
	},
	{
		Path: "alethia config get", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia config get web-origin", Note: "Print the control-plane URL and nothing else"},
			{Cmd: "alethia config get --output json", Note: "Every key and its value as one object"},
		},
	},
	// Writes the CLI's own config file. Setting a key to the value it has changes nothing.
	{
		Path: "alethia config set", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia config set web-origin https://alethia.example.com", Note: "Point the CLI at a self-hosted control plane"},
			{Cmd: "alethia config set", Note: "On a terminal: pick the key and edit its value in place"},
		},
	},
	// Writes the CLI's own config file, and nothing on the control plane. It is undone by
	// `alethia org switch`, so it is not recorded as destructive.
	{
		Path: "alethia config clear-context", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia config clear-context", Note: "Leave the active organization and act in your personal scope"},
		},
	},
	// The old name of `export --format console-json`. It runs, and is never listed.
	{
		Path: "alethia config export", Hidden: true, Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia export boutique --env prod --format console-json", Note: "Use the current name"},
		},
	},
}
