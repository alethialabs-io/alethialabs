// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

var opsInspectJobCmd = &cobra.Command{
	Use:   "inspect-job <job_id>",
	Short: "Read a job's full row cross-tenant (blast: none)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		runOpsAction("inspect_job", args[0], reason, "", nil, true)
	},
}

var opsRetryJobCmd = &cobra.Command{
	Use:   "retry-job <job_id>",
	Short: "Re-enqueue a fresh job from a stuck/failed one (blast: low)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		runOpsAction("retry_job", args[0], reason, "", nil, false)
	},
}

var opsCancelJobCmd = &cobra.Command{
	Use:   "cancel-job <job_id>",
	Short: "Cancel a job and signal its runner to stop mid-flight (blast: low)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		runOpsAction("cancel_job", args[0], reason, "", nil, false)
	},
}

func init() {
	for _, c := range []*cobra.Command{opsInspectJobCmd, opsRetryJobCmd, opsCancelJobCmd} {
		c.Flags().String("reason", "", "Incident reason recorded in the immutable audit (required)")
		opsCmd.AddCommand(c)
	}
}
