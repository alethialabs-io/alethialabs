package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var vineyardCmd = &cobra.Command{
	Use:   "vineyard",
	Short: "Manage vineyards (workspaces)",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `grape vineyard list`, `grape vineyard create <name>` or `grape vineyard delete <name>`")
	},
}

func init() {
	rootCmd.AddCommand(vineyardCmd)
}
