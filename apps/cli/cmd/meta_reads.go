// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaReads is the registry's entries for the read-only reports, bring-your-own sources and add-ons.
//
// Every runnable command of the family is listed, and the facts were set by reading each command's
// body. What each field means is documented once, on cmdmeta.Meta; TestMeta_TheRegistryAndTheTreeAgree
// fails on a runnable command with no entry.
//
// The examples use literal names — a project called shop with a staging environment, a chart called
// api, the loki and ingress-nginx add-ons — so each one can be run as written against things of that
// name. None carries a value that has to be copied out of another command's output.
var metaReads = []cmdmeta.Meta{
	// Reads, then asks only AFTER the table, and only when the page came back full.
	{
		Path: "alethia activity", Group: groupInspect, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia activity", Note: "The latest 50 entries of the organization's activity log"},
			{Cmd: "alethia activity -n 200 --output csv", Note: "The latest 200 entries, with the resource id in its own column"},
		},
	},
	{
		Path: "alethia billing", Group: groupOrganization, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia billing", Note: "The plan, the subscription status and when the period ends"},
			{Cmd: "alethia billing --output json"},
		},
	},
	{
		Path: "alethia usage", Group: groupOrganization, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia usage", Note: "Seats, runner minutes, projects and AI credits used"},
			{Cmd: "alethia usage --output json"},
		},
	},
	{Path: "alethia cost", Group: groupInspect},
	{
		Path: "alethia cost show", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia cost show --project shop", Note: "The latest priced cost of the project's default environment"},
			{Cmd: "alethia cost show -p shop -e staging --output json"},
		},
	},
	{Path: "alethia drift", Group: groupInspect},
	{
		Path: "alethia drift show", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia drift show --project shop", Note: "Whether any managed resource has diverged, across every environment"},
			{Cmd: "alethia drift show -p shop -e staging --output json"},
		},
	},
	{Path: "alethia staged", Group: groupInspect},
	{
		Path: "alethia staged list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia staged list --project shop", Note: "What the next apply of the default environment would push"},
			{Cmd: "alethia staged list -p shop -e staging --output json"},
		},
	},
	{Path: "alethia probes", Group: groupInspect},
	{
		Path: "alethia probes list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia probes list --project shop", Note: "Whether each environment's cluster still answers"},
			{Cmd: "alethia probes list -p shop --output json"},
		},
	},
	{Path: "alethia protection", Group: groupInspect},
	{
		Path: "alethia protection list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia protection list --project shop", Note: "What a promotion into each environment has to pass"},
			{Cmd: "alethia protection list -p shop --output csv"},
		},
	},
	{Path: "alethia promotion", Group: groupInspect},
	{
		Path: "alethia promotion list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia promotion list --project shop", Note: "Every promotion in the project, newest first"},
			{Cmd: "alethia promotion list -p shop -e production --output json", Note: "Only the promotions into production"},
		},
	},
	{
		Path: "alethia promotion get", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia promotion get --project shop", Note: "Choose one of the project's promotions and see who it waits on"},
			{Cmd: "alethia promotion get -p shop -e production", Note: "Choose among the promotions into production only"},
		},
	},
	{Path: "alethia repo", Group: groupInspect},
	{
		Path: "alethia repo list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia repo list", Note: "The GitHub repositories Alethia can reach"},
			{Cmd: "alethia repo list --provider gitlab --output json"},
		},
	},
	{Path: "alethia iac", Group: groupDeploy},
	{
		Path: "alethia iac show", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia iac show --project shop", Note: "The source attached to the default environment, and its scan state"},
			{Cmd: "alethia iac show -p shop -e staging --output json"},
		},
	},
	// Replaces the environment's one source, so a second run with the same input changes nothing.
	{
		Path: "alethia iac attach", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia iac attach -p shop -e staging --repo https://github.com/acme/infra --path iac/aws --ref main", Note: "Attach a module from a git repository"},
			{Cmd: "alethia iac attach -p shop -e staging", Note: "On a terminal: choose the repository and answer the rest"},
			{Cmd: "alethia iac attach -p shop -e staging --repo https://github.com/acme/infra --var region=eu-west-1 --output json", Note: "From a script, with one tfvar and the result as json"},
		},
	},
	// Queues an IAC_SCAN job each time it runs.
	{
		Path: "alethia iac scan", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia iac scan -p shop -e staging", Note: "Queue the scan; the job id is in the result"},
			{Cmd: "alethia iac scan -p shop -e staging --wait --timeout 10m", Note: "Wait for the verdict, at most ten minutes"},
		},
	},
	// Deletes the source's record; a second run finds nothing attached and says so.
	{
		Path: "alethia iac detach", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia iac detach -p shop -e staging", Note: "Stop managing the source; you confirm first"},
			{Cmd: "alethia iac detach -p shop -e staging --yes --output json", Note: "From a script"},
		},
	},
	{Path: "alethia chart", Group: groupDeploy},
	{
		Path: "alethia chart list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia chart list --project shop", Note: "The charts attached to the default environment, and whether each is scanned"},
			{Cmd: "alethia chart list -p shop -e staging --output json"},
		},
	},
	// An upsert on the chart id, so a second run with the same input changes nothing.
	{
		Path: "alethia chart attach", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia chart attach api -p shop -e staging --repo https://github.com/acme/charts --chart-path charts/api", Note: "Attach a chart from a git repository"},
			{Cmd: "alethia chart attach api -p shop -e staging --repo oci://registry.example.com/acme/api --ref 1.4.0", Note: "Attach a chart from an OCI registry"},
			{Cmd: "alethia chart attach -p shop -e staging", Note: "On a terminal: choose the repository and answer the rest"},
		},
	},
	// Queues a CHART_SCAN job each time it runs.
	{
		Path: "alethia chart scan", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia chart scan api -p shop -e staging", Note: "Queue the scan; the job id is in the result"},
			{Cmd: "alethia chart scan api -p shop -e staging --wait --output json", Note: "Wait for the verdict and read the result as json"},
		},
	},
	// Deletes the chart's record; a second run is refused as not found.
	{
		Path: "alethia chart detach", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia chart detach api -p shop -e staging", Note: "Detach the chart; you confirm first"},
			{Cmd: "alethia chart detach -p shop -e staging", Note: "On a terminal: choose which attached chart"},
			{Cmd: "alethia chart detach api -p shop -e staging --yes", Note: "From a script"},
		},
	},
	{Path: "alethia addon", Group: groupDeploy},
	{
		Path: "alethia addon list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia addon list --project shop", Note: "The add-ons in the default environment, their sync and any update"},
			{Cmd: "alethia addon list -p shop -e staging --output json"},
		},
	},
	// An upsert: settings merge key by key, so a second run with the same input changes nothing.
	{
		Path: "alethia addon enable", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia addon enable kube-prometheus-stack -p shop -e staging", Note: "Enable an add-on with its defaults"},
			{Cmd: "alethia addon enable loki -p shop -e staging --set retention_days=7", Note: "Change one setting; the others keep their stored values"},
			{Cmd: "alethia addon enable ingress-nginx -p shop -e staging --version 4.15.1", Note: "Pin the chart version"},
			{Cmd: "alethia addon enable -p shop -e staging", Note: "On a terminal: choose an installed add-on to reconfigure"},
		},
	},
	// Removes the add-on's workloads; a second run changes nothing further.
	{
		Path: "alethia addon disable", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia addon disable kube-prometheus-stack -p shop -e staging", Note: "Disable it; you confirm first"},
			{Cmd: "alethia addon disable kube-prometheus-stack -p shop -e staging --yes --output json", Note: "From a script"},
		},
	},
	// Opens a pull request, or returns the one already open: a second run opens nothing more.
	{
		Path: "alethia addon bump", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia addon bump kube-prometheus-stack -p shop -e staging", Note: "Open the pull request that moves a GitOps add-on to the catalog's version"},
			{Cmd: "alethia addon bump kube-prometheus-stack -p shop -e staging --output json", Note: "The pull request's url and number as fields"},
			{Cmd: "alethia addon bump kube-prometheus-stack -p shop -e staging --again", Note: "Open it again after closing the last one unmerged"},
		},
	},
}
