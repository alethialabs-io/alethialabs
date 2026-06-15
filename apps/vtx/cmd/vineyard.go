package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var vineyardCmd = &cobra.Command{
	Use:   "vineyard",
	Short: "Manage vineyards (workspaces)",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `vtx vineyard list`, `vtx vineyard create <name>` or `vtx vineyard delete <name>`")
	},
}

func init() {
	rootCmd.AddCommand(vineyardCmd)
}
