// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var opsOrphanDetectCmd = &cobra.Command{
	Use:   "orphan-detect",
	Short: "List orphan candidates for a single project (read-only, run-scoped; blast: none)",
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		project, _ := cmd.Flags().GetString("project")
		if project == "" {
			failf("--project <id> is required (orphan detection is run-scoped, never account-wide)")
		}
		input := &api.BreakglassActionInput{ProjectID: project}
		runOpsAction("orphan_detect", "", reason, "", input, true)
	},
}

var opsOrphanCleanCmd = &cobra.Command{
	Use:   "orphan-clean",
	Short: "Force-destroy detected orphans (blast: HIGH; ships INERT/fail-closed)",
	Long: "Cross-cloud force-destroy — the most dangerous action. Ships INERT: it refuses unless the\n" +
		"deployment is separately armed (ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED), and even then is\n" +
		"unimplemented rather than performing an unscoped delete. Requires a two-person --approval.",
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		project, _ := cmd.Flags().GetString("project")
		approval, _ := cmd.Flags().GetString("approval")
		if project == "" {
			failf("--project <id> is required (run-scoped, never account-wide)")
		}
		if approval == "" {
			failf("--approval <id> is required (high-blast, two-person).")
		}
		input := &api.BreakglassActionInput{ProjectID: project}
		// Bind the approval + audit to the project scope (resourceId == project).
		runOpsAction("orphan_clean", project, reason, approval, input, false)
	},
}

func init() {
	for _, c := range []*cobra.Command{opsOrphanDetectCmd, opsOrphanCleanCmd} {
		c.Flags().String("reason", "", "Incident reason recorded in the immutable audit (required)")
		c.Flags().String("project", "", "Project id to scope the scan/clean to (required)")
	}
	opsOrphanCleanCmd.Flags().String("approval", "", "Two-person approval token id (required)")
	opsCmd.AddCommand(opsOrphanDetectCmd)
	opsCmd.AddCommand(opsOrphanCleanCmd)
}
