// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// opsCmd groups the break-glass (privileged incident recovery) verbs. Every verb hits the SAME
// audited /api/breakglass/* endpoints as the operator UI, with the SAME bearer auth + append-only
// audit — terminal-first operators during an incident. The entire surface is gated behind
// ALETHIA_BREAKGLASS_ENABLED + the BREAKGLASS_OPERATORS allowlist server-side; a non-operator (or a
// disabled deployment) is refused with 403/404.
var opsCmd = &cobra.Command{
	Use:   "ops",
	Short: "Break-glass incident recovery (privileged, audited, gated)",
	Long: "Break-glass incident-recovery actions for on-call operators.\n\n" +
		"Every action is audited (append-only, written before the act), requires a --reason, and\n" +
		"typed-confirms the resource id server-side. High-blast actions (force-release-lock,\n" +
		"state-surgery, orphan-clean) additionally require a two-person --approval token minted by a\n" +
		"DIFFERENT operator via `alethia ops approve`.",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `alethia ops --help` to see the recovery verbs.")
	},
}

func init() {
	rootCmd.AddCommand(opsCmd)
}

// runOpsAction is the shared path for every ops verb: it opens a fresh time-boxed break-glass
// session (recording the reason), then executes the action against the single audited endpoint. The
// typed-confirm is satisfied by sending confirm == resourceId (the server enforces the equality).
func runOpsAction(action, resourceID, reason, approvalID string, input *api.BreakglassActionInput, readOnly bool) {
	if reason == "" {
		failf("--reason is required (an incident reason is recorded in the immutable audit)")
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
		failf("Failed to open break-glass session: %v", err)
	}

	params := api.BreakglassExecuteParams{
		SessionID:  session.SessionID,
		Action:     action,
		ResourceID: resourceID,
		Reason:     reason,
		ApprovalID: approvalID,
		Input:      input,
	}
	// Typed-confirm: mutating actions must echo the exact resource id (server-enforced).
	if !readOnly && resourceID != "" {
		params.Confirm = resourceID
	}

	var result *api.BreakglassResult
	ui.RunSpinner(fmt.Sprintf("Executing %s...", action), func() {
		result, err = client.ExecuteBreakglass(params)
	})
	if err != nil {
		failf("Action refused/failed: %v", err)
	}

	ui.Success(result.Detail)
	if len(result.Data) > 0 && string(result.Data) != "null" {
		var pretty json.RawMessage = result.Data
		out, merr := json.MarshalIndent(pretty, "", "  ")
		if merr == nil {
			fmt.Println(string(out))
		}
	}
}
