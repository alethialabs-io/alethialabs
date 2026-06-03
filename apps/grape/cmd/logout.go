package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out from the platform",
	Run: func(cmd *cobra.Command, args []string) {
		credsPath, err := getCredentialsPath()
		if err != nil {
			ui.Error(fmt.Sprintf("Error getting credentials path: %v", err))
			os.Exit(1)
		}

		if _, err := os.Stat(credsPath); os.IsNotExist(err) {
			ui.Info("You are not currently logged in.")
			return
		}

		if err := os.Remove(credsPath); err != nil {
			ui.Error(fmt.Sprintf("Error logging out: %v", err))
			os.Exit(1)
		}

		ui.Success("Successfully logged out.")
		ui.Info("To log back in, run " + ui.CyanStyle.Render("grape login"))
	},
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}


