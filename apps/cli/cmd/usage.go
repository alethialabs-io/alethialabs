// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var usageCmd = &cobra.Command{
	Use:   "usage",
	Short: "Show the active organization's current usage",
	Long: `Display the active organization's current usage: billable seats used vs the
purchased cap, managed-runner minutes consumed this period, the project count, and AI
credits used vs the plan's weekly grant. Read-only. Use --output json for scripting.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runUsage(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to get usage: %v", err)
		}
	},
}

// runUsage fetches the usage counters and renders them as a Field/Value card (table/csv)
// or the typed object (json). Seats and AI credits show as "used / cap" ratios.
func runUsage(c apiClient, out io.Writer, format string) error {
	usage, err := c.GetUsage()
	if err != nil {
		return err
	}
	rows := [][]string{
		{"Seats", fmt.Sprintf("%d / %d", usage.SeatsUsed, usage.SeatsCap)},
		{"Runner minutes", strconv.Itoa(usage.RunnerMinutes)},
		{"Projects", strconv.Itoa(usage.Projects)},
		{"AI credits", fmt.Sprintf("%d / %d", usage.AICreditsUsed, usage.AICreditsGranted)},
	}
	return ui.RenderCard(out, format, "alethia · usage", rows, usage)
}

func init() {
	rootCmd.AddCommand(usageCmd)
}
