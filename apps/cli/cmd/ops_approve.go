// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// opsApproveCmd is run by the SECOND operator to mint a two-person approval token for a high-blast
// action. The acting operator then passes the printed id as `--approval`. The server enforces that
// the approver and the actor are different people.
var opsApproveCmd = &cobra.Command{
	Use:   "approve <action> <resource_id>",
	Short: "Mint a two-person approval for a high-blast action (run by a SECOND operator)",
	Long: "Mint a single-use, TTL'd approval bound to a high-blast action + resource. Actions that\n" +
		"need one: force_release_state_lock, state_surgery, orphan_clean. The acting operator (a\n" +
		"DIFFERENT person) then passes the printed id as --approval.",
	Args: cobra.ExactArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		action, resourceID := args[0], args[1]
		reason, _ := cmd.Flags().GetString("reason")
		if reason == "" {
			failf("--reason is required")
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)

		var approval *api.BreakglassApproval
		ui.RunSpinner("Minting approval...", func() {
			approval, err = client.MintBreakglassApproval(action, resourceID, reason, nil)
		})
		if err != nil {
			failf("Failed to mint approval: %v", err)
		}
		ui.Success(fmt.Sprintf("Approval minted (expires %s)", approval.ExpiresAt))
		fmt.Printf("approval id: %s\n", approval.ApprovalID)
		fmt.Printf("%s\n", approval.Note)
	},
}

// opsSessionCmd opens a standalone break-glass session (the action verbs open their own; this is for
// inspecting/warming a session or scripts that reuse one).
var opsSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Open a standalone time-boxed break-glass session",
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		if reason == "" {
			failf("--reason is required")
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)

		var session *api.BreakglassSession
		ui.RunSpinner("Opening break-glass session...", func() {
			session, err = client.OpenBreakglassSession(reason)
		})
		if err != nil {
			failf("Failed to open session: %v", err)
		}
		ui.Success(fmt.Sprintf("Session opened for %s (expires %s)", session.Operator, session.ExpiresAt))
		fmt.Printf("session id: %s\n", session.SessionID)
	},
}

func init() {
	opsApproveCmd.Flags().String("reason", "", "Reason recorded in the immutable audit (required)")
	opsSessionCmd.Flags().String("reason", "", "Reason recorded in the immutable audit (required)")
	opsCmd.AddCommand(opsApproveCmd)
	opsCmd.AddCommand(opsSessionCmd)
}
