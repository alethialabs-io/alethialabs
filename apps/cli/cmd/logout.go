// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out from the platform",
	Run: func(cmd *cobra.Command, args []string) {
		credsPath, err := getCredentialsPath()
		if err != nil {
			failf("Error getting credentials path: %v", err)
		}

		if _, err := os.Stat(credsPath); os.IsNotExist(err) {
			ui.Info("You are not currently logged in.")
			return
		}

		if err := os.Remove(credsPath); err != nil {
			failf("Error logging out: %v", err)
		}

		ui.Success("Successfully logged out.")
		ui.Info("To log back in, run " + ui.CyanStyle.Render("alethia login"))
	},
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}
