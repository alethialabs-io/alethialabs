// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

var opsDrainRunnerCmd = &cobra.Command{
	Use:   "drain-runner <runner_id>",
	Short: "Mark an ONLINE runner DRAINING so it stops claiming jobs (blast: low)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		runOpsAction("drain_runner", args[0], reason, "", nil, false)
	},
}

var opsRestartRunnerCmd = &cobra.Command{
	Use:   "restart-runner <runner_id>",
	Short: "Drain a runner and wake the scaler to roll a replacement (blast: medium)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		runOpsAction("restart_runner", args[0], reason, "", nil, false)
	},
}

func init() {
	for _, c := range []*cobra.Command{opsDrainRunnerCmd, opsRestartRunnerCmd} {
		c.Flags().String("reason", "", "Incident reason recorded in the immutable audit (required)")
		opsCmd.AddCommand(c)
	}
}
