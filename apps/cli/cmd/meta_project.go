// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaProject is the registry's entries for the project family.
//
// Every runnable command of the family is listed with its facts and its examples. What each field
// means is documented once, on cmdmeta.Meta. The facts were checked against the command bodies:
// TestMetaProject_TheFactsMatchTheCommands holds the ones a test can read off the tree, and
// TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no entry.
//
// The examples use literal names — a project called boutique, an environment called prod — so
// each one can be run as written against a project of that name. None carries a value that has to
// be copied out of another command's output.
var metaProject = []cmdmeta.Meta{
	{Path: "alethia project", Group: groupDeploy},
	{
		Path: "alethia project list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project list", Note: "Every project in the active organization"},
			{Cmd: "alethia project list --output json", Note: "The same list for a program"},
		},
	},
	{
		Path: "alethia project get", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project get boutique", Note: "Print one project's configuration"},
			{Cmd: "alethia project get boutique --open", Note: "Print it and open it in the console"},
			{Cmd: "alethia project get --project boutique --output json", Note: "The whole record for a program"},
		},
	},
	// Creates a record. A second run with the same name is a second project, or a refusal.
	{
		Path: "alethia project create", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project create boutique --region eu-west-1 --cloud-account prod-account", Note: "Create a project in one cloud account"},
			{Cmd: "alethia project create boutique --file alethia.yaml", Note: "Take the region, account and environments from a file"},
			{Cmd: "alethia project create boutique --region eu-west-1 --cloud-account prod-account --dry-run --output json", Note: "Check the input and print the request, without creating anything"},
		},
	},
	// Queues a PLAN job. No infrastructure changes, but a job is created each time.
	{
		Path: "alethia project preview", Mutates: true, LongRunning: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project preview --project boutique --wait", Note: "Work out what a deploy would change, and wait for the answer"},
			{Cmd: "alethia project preview --project boutique --env prod --runner primary --wait --timeout 30m", Note: "One environment, on a named runner, waiting at most 30 minutes"},
		},
	},
	// Queues a DEPLOY job, so a second run is a second deploy. A deploy can replace or remove a
	// cloud resource the design no longer has; it is recorded as mutating and long-running, like
	// `alethia apply`, and it confirms before it queues.
	{
		Path: "alethia project deploy", Mutates: true, LongRunning: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project deploy --project boutique --latest-plan --wait", Note: "Deploy the plan you just previewed, and wait for it"},
			{Cmd: "alethia project deploy --project boutique --env prod --yes --output json", Note: "Queue a deploy from a script and read the job id from the result"},
			{Cmd: "alethia project deploy --project boutique --dry-run", Note: "Check the input and print the request, without queuing anything"},
		},
	},
	// The old names of preview and deploy. They run, and are never listed.
	{
		Path: "alethia project plan", Hidden: true, Mutates: true, LongRunning: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project preview --project boutique --wait", Note: "Use the current name"},
		},
	},
	{
		Path: "alethia project apply", Hidden: true, Mutates: true, LongRunning: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project deploy --project boutique --latest-plan --wait", Note: "Use the current name"},
		},
	},
	// Queues a DESTROY job each time it runs, and with --cascade one per environment.
	{
		Path: "alethia project destroy", Mutates: true, Destructive: true, LongRunning: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project destroy --project boutique --env dev-1", Note: "Destroy one environment; you type the project's name to confirm"},
			{Cmd: "alethia project destroy --project boutique --env prod --cascade --dry-run", Note: "See every environment a cascade would destroy, and destroy nothing"},
			{Cmd: "alethia project destroy --project boutique --env dev-1 --yes --wait --timeout 45m", Note: "From a script: confirm with --yes and wait for the job"},
		},
	},
	{
		Path: "alethia project env list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project env list --project boutique", Note: "A project's environments and how each is placed"},
			{Cmd: "alethia project env list --project boutique --output json"},
		},
	},
	// Creates a record. A second run with the same name is refused.
	{
		Path: "alethia project env add", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project env add dev-1 --project boutique --stage development --placement-mode namespace", Note: "A development environment that shares the existing cluster"},
			{Cmd: "alethia project env add staging --project boutique --stage staging --placement-mode dedicated --region eu-central-1", Note: "A staging environment with a cluster of its own"},
		},
	},
	{
		Path: "alethia project component kinds", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project component kinds", Note: "Every kind --kind accepts, and which need a name"},
		},
	},
	{
		Path: "alethia project component list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project component list --project boutique", Note: "Every component, in every environment"},
			{Cmd: "alethia project component list --project boutique --env prod --kind databases --output json"},
		},
	},
	// A singleton kind is written in place, so repeating it changes nothing further; a multi kind
	// with a name that exists is refused. Neither is "safe to repeat" for every input.
	{
		Path: "alethia project component add", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project component add --project boutique --kind databases --name orders --set engine=postgres", Note: "A named database in the default environment"},
			{Cmd: "alethia project component add --project boutique --env prod --kind cluster --set node_min_size=2 --set node_max_size=6", Note: "Change two fields of one environment's cluster"},
		},
	},
	// Removes one component from one environment. Repeating it reports that the component is gone.
	{
		Path: "alethia project component remove", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project component remove --project boutique --kind databases --name orders", Note: "Remove one named component; asks first"},
			{Cmd: "alethia project component remove --project boutique --env dev-1 --kind dns --yes", Note: "From a script: a singleton needs no name"},
		},
	},
	// Declarative: the document is the whole design, so applying it can remove a component the
	// document no longer lists, and applying it twice leaves what applying it once left. Its dry
	// run is done by the control plane, which validates the document without writing.
	{
		Path: "alethia project design apply", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunServer, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia project design apply --project boutique --file design.json --dry-run", Note: "Print what the document would change, and write nothing"},
			{Cmd: "alethia project design apply --project boutique --env prod --file design.json", Note: "Apply it; asks first when the plan removes a component"},
			{Cmd: "alethia project design apply --project boutique --file design.json --stage", Note: "Put the change in the review tray instead of applying it"},
		},
	},
}
