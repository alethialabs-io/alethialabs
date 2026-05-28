package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/api"
	"github.com/spf13/cobra"
)

var pullOutputPath string

var pullCmd = &cobra.Command{
	Use:   "pull [project_name]",
	Short: "Pull a configuration as a legacy-compatible YAML file",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		projectName := args[0]

		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)
		export, err := apiClient.ExportConfiguration(projectName, "legacy-yaml")
		if err != nil {
			fmt.Printf("Error exporting configuration: %v\n", err)
			os.Exit(1)
		}

		outputPath := pullOutputPath
		if outputPath == "" {
			outputPath = export.Filename
		}

		outputDir := filepath.Dir(outputPath)
		if outputDir != "." {
			if err := os.MkdirAll(outputDir, 0755); err != nil {
				fmt.Printf("Error creating output directory: %v\n", err)
				os.Exit(1)
			}
		}

		if err := os.WriteFile(outputPath, []byte(export.Content), 0644); err != nil {
			fmt.Printf("Error writing configuration file: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("Pulled %s to %s\n", projectName, outputPath)
	},
}

func init() {
	configCmd.AddCommand(pullCmd)
	pullCmd.Flags().StringVarP(&pullOutputPath, "output", "o", "", "Output file path")
}
