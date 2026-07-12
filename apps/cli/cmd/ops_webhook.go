// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var opsReplayWebhookCmd = &cobra.Command{
	Use:   "replay-webhook <stripe_event_id>",
	Short: "Re-dispatch a stored Stripe webhook event idempotently (blast: low)",
	Long: "Replays a stored Stripe event through the SAME idempotent handler the live webhook uses.\n" +
		"Branded emails are SUPPRESSED by default (the one non-idempotent side effect); pass\n" +
		"--send-emails to re-send them.",
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason, _ := cmd.Flags().GetString("reason")
		sendEmails, _ := cmd.Flags().GetBool("send-emails")
		suppress := !sendEmails
		input := &api.BreakglassActionInput{SuppressEmails: &suppress}
		runOpsAction("replay_webhook", args[0], reason, "", input, false)
	},
}

func init() {
	opsReplayWebhookCmd.Flags().String("reason", "", "Incident reason recorded in the immutable audit (required)")
	opsReplayWebhookCmd.Flags().Bool("send-emails", false, "Re-send the branded emails on replay (default: suppressed)")
	opsCmd.AddCommand(opsReplayWebhookCmd)
}
