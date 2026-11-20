// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaJobs is the registry's entries for jobs, clusters and verification.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. The facts below were checked against the command bodies,
// and where one is not what the command's name suggests a comment says why.
// TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no entry, and
// TestMetaJobs_EveryCommandHasARunnableExample on one with no example.
//
// Every example runs as written: it uses `--latest`, a literal name, or no selector at all, never
// an id the reader would have to copy out of another command's output.
var metaJobs = []cmdmeta.Meta{
	{Path: "alethia jobs", Group: groupInspect},
	{
		Path: "alethia jobs list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia jobs list", Note: "Page through the newest jobs."},
			{Cmd: "alethia jobs list --status FAILED --limit 50", Note: "The 50 newest failed jobs."},
			{Cmd: "alethia jobs list --all -o json", Note: "Every job as one JSON object, with the total."},
		},
	},
	{
		Path: "alethia jobs get", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia jobs get --latest", Note: "The most recent job."},
			{Cmd: "alethia jobs get --latest --type DEPLOY --project web", Note: "The newest deploy of the project web, with any warnings it ended with."},
			{Cmd: "alethia jobs get --latest -o json", Note: "The same job as JSON, with a warnings array."},
		},
	},
	{
		Path: "alethia jobs logs", Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia jobs logs --latest", Note: "What the newest job has logged so far."},
			{Cmd: "alethia jobs logs --latest --follow", Note: "Follow it to the end. Exits 13 when the job failed or was cancelled."},
			{Cmd: "alethia jobs logs --latest --type DEPLOY --follow --timeout 30m", Note: "Stop following after 30 minutes with exit 12. The job keeps running."},
		},
	},
	// Stops a job; it does not remove one. It is marked destructive because a cancelled apply can
	// leave an environment between two states, which is why the command confirms. Repeating it on
	// a job that is already cancelled changes nothing and is refused with a conflict.
	{
		Path: "alethia jobs cancel", Mutates: true, Destructive: true, Idempotent: true,
		DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia jobs cancel --latest", Note: "Cancel the newest job that can still be cancelled, after a confirmation."},
			{Cmd: "alethia jobs cancel --latest --type DEPLOY --project web --yes", Note: "Cancel the running deploy of web without a prompt."},
			{Cmd: "alethia jobs cancel --latest --dry-run", Note: "Show which job would be cancelled and cancel nothing."},
		},
	},
	{Path: "alethia cluster", Group: groupInspect},
	{
		Path: "alethia cluster list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia cluster list", Note: "Every cluster, one row per project environment."},
			{Cmd: "alethia cluster list -o json", Note: "The same list as JSON."},
		},
	},
	{
		Path: "alethia cluster get", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia cluster get", Note: "Pick a cluster at a terminal."},
			{Cmd: "alethia cluster get web", Note: "The cluster of the project web."},
			{Cmd: "alethia cluster get web -o json", Note: "The same cluster as JSON, with its GitOps state."},
		},
	},
	// Mints a short-lived credential each time: the control plane records the request and queues a
	// job for a runner, and this command waits for it, so it is not long-running from the
	// caller's side. It also stores the credential and the tier it was minted with in the CLI's own
	// cache, which is the state that makes it a mutation. Repeating it replaces the same context.
	{
		Path: "alethia cluster kubeconfig", Mutates: true, Idempotent: true, Output: cmdmeta.OutputSecret,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia cluster kubeconfig web", Note: "Read-only access to web's cluster for 1h, merged into your kubeconfig."},
			{Cmd: "alethia cluster kubeconfig web --admin --ttl 30m", Note: "Admin access for 30 minutes."},
			{Cmd: "alethia cluster kubeconfig web --static --out ./web.kubeconfig", Note: "A self-contained file, written with mode 0600."},
			{Cmd: "alethia cluster kubeconfig web --static --out -", Note: "Print the kubeconfig on stdout and write no file."},
		},
	},
	// The exec plugin a kubeconfig runs. It writes the credential it minted to the CLI's own cache,
	// which is the state that makes it a mutation; a call served from the cache changes nothing.
	{
		Path: "alethia cluster token", Mutates: true, Idempotent: true, Output: cmdmeta.OutputSecret,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia cluster token", Note: "Pick a cluster at a terminal, to check that your session can still mint a credential."},
		},
	},
	{Path: "alethia verify", Group: groupInspect},
	{
		Path: "alethia verify receipt", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia verify receipt --latest --status SUCCESS", Note: "Check the signature on the newest finished plan or deploy."},
			{Cmd: "alethia verify receipt --latest --type DEPLOY --project web -o json", Note: "The verdict and the receipt as JSON."},
			{Cmd: "alethia verify receipt --latest --status SUCCESS --key-file ./alethia-signing.pub", Note: "Verify against a public key you hold, not the control plane's set."},
		},
	},
	{
		Path: "alethia verify show", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia verify show --latest --status SUCCESS", Note: "The per-control report of the newest finished plan or deploy."},
			{Cmd: "alethia verify show --latest --type PLAN --project web -o json", Note: "The whole report as JSON."},
		},
	},
}
