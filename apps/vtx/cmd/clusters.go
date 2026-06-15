package cmd

import "github.com/spf13/cobra"

var clusterCmd = &cobra.Command{
	Use:   "cluster",
	Short: "View vine cluster information",
	Long:  `List and inspect the Kubernetes clusters provisioned for your vines.`,
}

func init() {
	rootCmd.AddCommand(clusterCmd)
}
