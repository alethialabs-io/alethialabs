// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var opsUnstickEnvCmd = &cobra.Command{
	Use:   "unstick-env <environment_id>",
	Short: "Move a stuck environment via the set_env_status CAS (blast: medium)",
	Long: "Move a stuck environment to a target status via the compare-and-swap primitive (never a\n" +
		"raw UPDATE). You MUST pass the explicit expected-from set and target; a CAS miss is refused.",
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		from, _ := cmd.Flags().GetString("from")
		to, _ := cmd.Flags().GetString("to")
		if from == "" || to == "" {
			failf("--from (comma-separated statuses) and --to are required")
		}
		expected := []string{}
		for _, s := range strings.Split(from, ",") {
			if t := strings.TrimSpace(s); t != "" {
				expected = append(expected, t)
			}
		}
		input := &api.BreakglassActionInput{ExpectedFrom: expected, To: strings.TrimSpace(to)}
		runOpsAction("unstick_env", args[0], reason, "", input, false)
	},
}

func init() {
	opsUnstickEnvCmd.Flags().String("reason", "", "Incident reason recorded in the immutable audit (required)")
	opsUnstickEnvCmd.Flags().String("from", "", "Comma-separated expected current statuses (CAS precondition)")
	opsUnstickEnvCmd.Flags().String("to", "", "Target status to move the environment to")
	opsCmd.AddCommand(opsUnstickEnvCmd)
}
