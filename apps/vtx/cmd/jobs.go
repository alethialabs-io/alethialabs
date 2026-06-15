package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var jobsCmd = &cobra.Command{
	Use:   "jobs",
	Short: "Manage provisioning jobs",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `vtx jobs list`, `vtx jobs get <id>`, `vtx jobs logs <id>`, or `vtx jobs cancel <id>`")
	},
}

func init() {
	rootCmd.AddCommand(jobsCmd)
}
