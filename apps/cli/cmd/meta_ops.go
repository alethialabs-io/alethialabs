// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaOps is the registry's entries for the ops family: privileged incident recovery.
//
// Every runnable command of the family is listed, and the facts were set by reading each
// command's body and the server action it dispatches (apps/console/lib/breakglass/actions.ts).
// What each field means is documented once, on cmdmeta.Meta; TestMeta_TheRegistryAndTheTreeAgree
// fails on a runnable command with no entry.
//
// Two facts hold for every verb and decide two columns, so they are stated once here:
//
//   - Every verb MUTATES, the two read-only ones included: each run opens a break-glass session and
//     writes an audit row before it acts, and both outlive the command. A read-only verb is one that
//     changes nothing ELSE, which is what its missing --yes says.
//   - No verb is IDEMPOTENT: a second run opens a second session and writes a second audit row,
//     whatever it does to its subject.
//
// No verb has a dry run. A break-glass action is checked by the server's catalog at the moment it
// runs, and a client-side rehearsal would say nothing the audited run does not.
//
// The examples use the pickers where a verb has one, so they run as written at a terminal. Where an
// id has to come from somewhere it is the id an alert gives the operator — break-glass reaches
// resources no listing of this CLI contains — and the approval id is the one a second operator
// reads out from their own `ops approve` run, which is the point of a two-person token.
var metaOps = []cmdmeta.Meta{
	// The whole group sits behind one capability, named on its parent: everything below a
	// command that is not listed is not listed either. ALETHIA_OPS=1 turns it on.
	{
		Path: "alethia ops", Group: groupOrganization, Idempotent: true, Capability: CapabilityOps, Output: cmdmeta.OutputNone,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops", Note: "The verbs and each one's blast radius; set ALETHIA_OPS=1 to list the group in alethia --help"},
		},
	},
	{
		Path: "alethia ops session", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops session --reason pre-incident-access-check", Note: "Prove your login can break glass before an incident needs it"},
			{Cmd: "alethia ops session --reason pre-incident-access-check --output json", Note: "The session as the shared result shape; .id is the session id"},
		},
	},
	{
		Path: "alethia ops approve", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops approve", Note: "As the second operator: pick the action, then name the resource and the reason"},
			{Cmd: "alethia ops approve force_release_state_lock projects/acme/prod.tfstate --reason INC-4711-signoff", Note: "Bind the approval to one state lock, then read the printed id out to the acting operator"},
			{Cmd: "alethia ops approve force_release_state_lock projects/acme/prod.tfstate --reason INC-4711-signoff --output json", Note: "The approval as the shared result shape; .id is the value for --approval"},
		},
	},
	{
		Path: "alethia ops inspect-job", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops inspect-job --reason INC-4711-deploy-hung", Note: "Pick one of your organization's recent jobs and read its full row"},
			{Cmd: "alethia ops inspect-job 8f3c2a1b-77de-4c05-9a41-2b8e6a1d40f7 --reason INC-4711-deploy-hung --output json", Note: "A job an alert named, in any organization, as JSON"},
		},
	},
	// Creates a fresh job from the old one each time it runs.
	{
		Path: "alethia ops retry-job", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops retry-job --reason INC-4711-runner-crashed", Note: "Pick the job, confirm, and queue it again"},
			{Cmd: "alethia ops retry-job 8f3c2a1b-77de-4c05-9a41-2b8e6a1d40f7 --reason INC-4711-runner-crashed --yes --wait --timeout 30m", Note: "From a runbook: queue it and follow the new job, exiting 13 if it fails"},
		},
	},
	// Stops work mid-flight; what was already applied is not rolled back.
	{
		Path: "alethia ops cancel-job", Mutates: true, Destructive: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops cancel-job --reason INC-4711-wrong-project", Note: "Pick the job and confirm"},
			{Cmd: "alethia ops cancel-job 8f3c2a1b-77de-4c05-9a41-2b8e6a1d40f7 --reason INC-4711-wrong-project --yes --output json", Note: "From a runbook, with the result as JSON"},
		},
	},
	{
		Path: "alethia ops drain-runner", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops drain-runner --reason INC-4711-node-degraded", Note: "Pick the runner, offline ones included, and confirm"},
			{Cmd: "alethia ops drain-runner e77b1c40-9a2f-4d61-8c33-5b0e2a7f9d41 --reason INC-4711-node-degraded --yes", Note: "A runner an alert named, from a runbook"},
		},
	},
	// Drains the runner and wakes the scaler; the runner's record stays, DRAINING.
	{
		Path: "alethia ops restart-runner", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops restart-runner --reason INC-4711-wedged-runner", Note: "Pick the runner and confirm"},
			{Cmd: "alethia ops restart-runner e77b1c40-9a2f-4d61-8c33-5b0e2a7f9d41 --reason INC-4711-wedged-runner --yes", Note: "From a runbook"},
		},
	},
	{
		Path: "alethia ops unstick-env", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops unstick-env --reason INC-4711-env-stuck-after-crash", Note: "Pick the project and environment; the move starts from the status it is in"},
			{Cmd: "alethia ops unstick-env 5c1f0a92-3d77-4a10-b8e2-7f9d4c6b1a03 --from PROVISIONING --to FAILED --reason INC-4711-env-stuck-after-crash --yes", Note: "From a runbook: both sides of the compare-and-swap are explicit"},
		},
	},
	{
		Path: "alethia ops replay-webhook", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops replay-webhook evt_1P9xKjLkdIwHu7ix --reason INC-4711-missed-invoice", Note: "Replay a stored Stripe event with its emails suppressed"},
			{Cmd: "alethia ops replay-webhook evt_1P9xKjLkdIwHu7ix --send-emails --reason INC-4711-receipt-never-sent --yes", Note: "Replay it and re-send the branded emails"},
		},
	},
	// Rotates the fencing token: a writer still holding the lock is fenced out mid-apply.
	{
		Path: "alethia ops force-release-lock", Mutates: true, Destructive: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops force-release-lock projects/acme/prod.tfstate --reason INC-4711-runner-died-holding-lock", Note: "You are asked for the approval id the second operator read out"},
			{Cmd: "alethia ops force-release-lock projects/acme/prod.tfstate --approval 6b21d8f4-0c5e-4a93-9f27-3d81b6e5c704 --reason INC-4711-runner-died-holding-lock --yes", Note: "From a runbook, with the approval given"},
		},
	},
	{
		Path: "alethia ops orphan-detect", Mutates: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops orphan-detect --reason INC-4711-post-incident-sweep", Note: "Pick the project and list its orphan candidates"},
			{Cmd: "alethia ops orphan-detect --project 1d4e7c30-8b62-4f95-a70d-9c2e5b1a3f88 --reason INC-4711-post-incident-sweep --output json", Note: "One project's candidates as JSON"},
		},
	},
	// Hidden whatever the switch says: the server refuses it unless separately armed, and even then
	// it is unimplemented. Listing a verb that cannot work tells an operator it is an option.
	{
		Path: "alethia ops orphan-clean", Mutates: true, Destructive: true, Hidden: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops orphan-clean --project 1d4e7c30-8b62-4f95-a70d-9c2e5b1a3f88 --approval 6b21d8f4-0c5e-4a93-9f27-3d81b6e5c704 --reason INC-4711-cleanup-approved --yes", Note: "Refused by the server until its executor ships"},
		},
	},
	// Hidden whatever the switch says: the job it queues fails by design until the runner-side
	// executor ships.
	{
		Path: "alethia ops state-surgery", Mutates: true, Destructive: true, LongRunning: true, Hidden: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia ops state-surgery projects/acme/prod.tfstate --approval 6b21d8f4-0c5e-4a93-9f27-3d81b6e5c704 --note import-orphaned-rds --reason INC-4711-failed-apply --yes --wait", Note: "Queues a job that fails cleanly until its executor ships"},
		},
	},
}
