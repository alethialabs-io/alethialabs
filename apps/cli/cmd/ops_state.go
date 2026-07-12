// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// force-release-lock and state-surgery are HIGH-blast: they require a two-person --approval token
// minted by a DIFFERENT operator via `alethia ops approve`.

var opsForceReleaseLockCmd = &cobra.Command{
	Use:   "force-release-lock <state_key>",
	Short: "Force-release a stranded tofu state lock (blast: HIGH, two-person)",
	Long: "Rotates the fencing token + bumps generation (never a naive delete), so a zombie writer is\n" +
		"fenced out. Requires a two-person --approval token from a different operator.",
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		approval, _ := cmd.Flags().GetString("approval")
		if approval == "" {
			failf("--approval <id> is required (high-blast, two-person). Mint one with `alethia ops approve`.")
		}
		runOpsAction("force_release_state_lock", args[0], reason, approval, nil, false)
	},
}

var opsStateSurgeryCmd = &cobra.Command{
	Use:   "state-surgery <state_key>",
	Short: "Queue a privileged STATE_SURGERY job through the pipeline (blast: HIGH, two-person; INERT)",
	Long: "Enqueues a privileged STATE_SURGERY job through the NORMAL runner/state pipeline (fencing\n" +
		"intact). The runner-side executor ships INERT (fail-closed) — the job will fail cleanly\n" +
		"without mutating state. Requires a two-person --approval token from a different operator.",
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		approval, _ := cmd.Flags().GetString("approval")
		note, _ := cmd.Flags().GetString("note")
		if approval == "" {
			failf("--approval <id> is required (high-blast, two-person). Mint one with `alethia ops approve`.")
		}
		var input *api.BreakglassActionInput
		if note != "" {
			input = &api.BreakglassActionInput{SurgeryNote: note}
		}
		runOpsAction("state_surgery", args[0], reason, approval, input, false)
	},
}

func init() {
	for _, c := range []*cobra.Command{opsForceReleaseLockCmd, opsStateSurgeryCmd} {
		c.Flags().String("reason", "", "Incident reason recorded in the immutable audit (required)")
		c.Flags().String("approval", "", "Two-person approval token id (required)")
	}
	opsStateSurgeryCmd.Flags().String("note", "", "Free-form description of the intended repair (audit only)")
	opsCmd.AddCommand(opsForceReleaseLockCmd)
	opsCmd.AddCommand(opsStateSurgeryCmd)
}
