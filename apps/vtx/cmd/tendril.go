package cmd

import (
	"github.com/spf13/cobra"
)

var tendrilCmd = &cobra.Command{
	Use:   "tendril",
	Short: "Manage tendrils (provisioning workers)",
	Long: `Tendrils are provisioning workers that execute infrastructure jobs.

Use the subcommands to list, deploy, destroy, or remove tendrils.`,
}

func init() {
	rootCmd.AddCommand(tendrilCmd)
}
