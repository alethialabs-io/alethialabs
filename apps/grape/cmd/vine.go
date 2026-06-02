package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var vineCmd = &cobra.Command{
	Use:   "vine",
	Short: "Manage vines (infrastructure configurations)",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `grape vine list` or `grape vine get <name>`")
	},
}

func init() {
	rootCmd.AddCommand(vineCmd)
}
