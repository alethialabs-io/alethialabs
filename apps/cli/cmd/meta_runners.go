// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
)

// metaRunners is the registry's entries for the runners family: runners and the managed fleet.
//
// Every runnable command of the family is listed, and the facts were set by reading each
// command's body. What each field means is documented once, on cmdmeta.Meta;
// TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no entry.
//
// The examples use literal names — a runner called eu-runner, a cloud account labelled
// prod-account — so each one can be run as written against things of that name. None carries a
// value that has to be copied out of another command's output.
var metaRunners = []cmdmeta.Meta{
	{Path: "alethia runner", Group: groupDeploy},
	{
		Path: "alethia runner list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia runner list", Note: "Every runner the active organization can see, and whether it is online"},
			{Cmd: "alethia runner list --output json", Note: "The same list for a program"},
		},
	},
	// Creates a runner record and queues a DEPLOY_RUNNER job each time it runs, so a second run is
	// a second runner. The clouds are the ones a runner template exists for
	// (packages/core/runners); the job needs a runner that is already online to run it.
	{
		Path: "alethia runner deploy", Mutates: true, LongRunning: true, DryRun: cmdmeta.DryRunClient,
		Clouds: runners.DeployProviders(), Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia runner deploy --cloud-account prod-account --name eu-runner --region eu-west-1 --wait", Note: "Build a runner in one cloud account and wait for it"},
			{Cmd: "alethia runner deploy --cloud-account prod-account --dry-run --output json", Note: "Check the input and print the request, without creating anything"},
			{Cmd: "alethia runner deploy --cloud-account prod-account --no-input --wait --timeout 30m", Note: "From a script: default name and region, waiting at most 30 minutes"},
		},
	},
	// Creates a runner record and prints its token once; nothing is provisioned and no job is
	// queued. A second run with the same name is a second runner with a different token.
	{
		Path: "alethia runner register", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputSecret,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia runner register my-box-1", Note: "Register a runner you run yourself; its id and token are printed once"},
			{Cmd: "alethia runner register my-box-1 --no-input", Note: "From a script: stdout is the two KEY=value lines and nothing else, ready to redirect into an env file"},
			{Cmd: "alethia runner register my-box-1 --cloud-account prod-account --output json", Note: "Record the account it works in, and read the id and token as fields"},
		},
	},
	// Queues a DESTROY_RUNNER job each time it runs. Confirms by the runner's name.
	{
		Path: "alethia runner destroy", Mutates: true, Destructive: true, LongRunning: true, DryRun: cmdmeta.DryRunClient,
		Clouds: runners.DeployProviders(), Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia runner destroy --runner eu-runner", Note: "Tear a deployed runner down; you type its name to confirm"},
			{Cmd: "alethia runner destroy --runner eu-runner --dry-run", Note: "Check the input and print the request, without queuing anything"},
			{Cmd: "alethia runner destroy --runner eu-runner --yes --wait --timeout 30m", Note: "From a script: confirm with --yes and wait for the job"},
		},
	},
	// Deletes the record. A second run finds no runner of that name and says so.
	{
		Path: "alethia runner remove", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia runner remove --runner my-box-1", Note: "Delete a runner's record; you type its name to confirm"},
			{Cmd: "alethia runner remove --runner my-box-1 --yes --output json", Note: "From a script, with the result as json"},
		},
	},
	{Path: "alethia fleet", Group: groupDeploy},
	{
		Path: "alethia fleet list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia fleet list", Note: "Each cloud's warm pool and its size"},
			{Cmd: "alethia fleet list --output json"},
		},
	},
	// Sets the pool to the values given, so a second run changes nothing further. Pausing a pool
	// (--enabled=false) drains its runners and is confirmed, but removes no record.
	{
		Path: "alethia fleet set", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia fleet set aws --warm-min 2 --max 6", Note: "Keep two AWS runners warm and allow up to six"},
			{Cmd: "alethia fleet set hetzner --enabled=false --yes", Note: "Pause the Hetzner pool from a script"},
			{Cmd: "alethia fleet set gcp --version 1.4.0 --output json", Note: "Pin the GCP pool to one runner version and read the pool back as json"},
		},
	},
}
