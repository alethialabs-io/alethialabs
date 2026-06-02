package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var jobsCmd = &cobra.Command{
	Use:   "jobs",
	Short: "Manage provisioning jobs",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `grape jobs list`, `grape jobs get <id>`, `grape jobs logs <id>`, or `grape jobs cancel <id>`")
	},
}

func init() {
	rootCmd.AddCommand(jobsCmd)
}
