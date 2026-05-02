package cmd

import (
	"github.com/spf13/cobra"
)

var provisionCmd = &cobra.Command{
	Use:   "provision",
	Short: "Alias for 'harvest'",
	Run: func(cmd *cobra.Command, args []string) {
		harvestCmd.Run(cmd, args)
	},
}

func init() {
	rootCmd.AddCommand(provisionCmd)
	// Inherit flags from harvestCmd if needed, but since they are global vars in harvest.go it should work
}
