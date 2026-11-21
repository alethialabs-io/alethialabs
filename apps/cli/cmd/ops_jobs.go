// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

// The job verbs. Each takes the job id as an OPTIONAL positional: given one it passes through byte
// for byte and makes no listing call, and given none on a terminal it offers the organization's
// recent jobs — the same line `jobs list` shows, through the same renderer.

var opsInspectJobCmd = &cobra.Command{
	Use:   "inspect-job [job-id]",
	Short: "Read a job's full row cross-tenant (blast: none)",
	Long: "Read one job's full row, bypassing row-level security, for diagnosis. Read-only: nothing is\n" +
		"mutated, no typed-confirm is sent, and no confirmation is asked for.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		jobID := opsResolveJobID(cmd, args)
		runOpsAction(opsRequest{Cmd: cmd, ResourceID: jobID, Reason: reason})
	},
}

var opsRetryJobCmd = &cobra.Command{
	Use:   "retry-job [job-id]",
	Short: "Re-enqueue a fresh job from a stuck/failed one (blast: low)",
	Long: "Queue a fresh job from a stuck or failed one, so the work runs again and the poison counter\n" +
		"resets. Use it when a job died with its runner and will not be picked up again.\n\n" +
		"The new job's id is the result's job. Pass --wait to follow it to the end: the command\n" +
		"then exits 13 when the job fails, and 12 when --timeout passes first.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		jobID := opsResolveJobID(cmd, args)
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: jobID, Reason: reason,
			Resource:    "job " + jobID,
			Consequence: "A fresh job is queued from it and the work runs again; the poison counter resets",
		})
	},
}

var opsCancelJobCmd = &cobra.Command{
	Use:   "cancel-job [job-id]",
	Short: "Cancel a job and signal its runner to stop mid-flight (blast: low)",
	Long: "Cancel a job in any organization and signal its runner to stop mid-flight. Work already\n" +
		"applied is not rolled back. Use it when `alethia jobs cancel` cannot reach the job: it is\n" +
		"in another organization, or its runner no longer answers.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		jobID := opsResolveJobID(cmd, args)
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: jobID, Reason: reason,
			Resource:    "job " + jobID,
			Consequence: "Its runner is signalled to stop mid-flight; work already applied is not rolled back",
		})
	},
}

func init() {
	registerOpsVerb(opsInspectJobCmd)
	registerOpsVerb(opsRetryJobCmd)
	registerOpsVerb(opsCancelJobCmd)
}
