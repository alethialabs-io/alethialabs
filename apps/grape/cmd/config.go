package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage configurations",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `grape config list`, `grape config get <name>`, or `grape config pull <project_name>`")
	},
}

func init() {
	rootCmd.AddCommand(configCmd)
}
