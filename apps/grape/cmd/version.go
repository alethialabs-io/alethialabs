package cmd

import (
	"fmt"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/internal/version"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the grape CLI version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("grape v%s\n", version.Version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
