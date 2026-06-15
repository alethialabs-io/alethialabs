package cmd

import (
	"github.com/spf13/cobra"
)

var vineCmd = &cobra.Command{
	Use:   "vine",
	Short: "Manage vines (infrastructure configurations)",
	Long: `Vines are infrastructure configurations for projects.

Use the subcommands to list, view, plan, apply, or destroy vine infrastructure.`,
}

func init() {
	rootCmd.AddCommand(vineCmd)
}
