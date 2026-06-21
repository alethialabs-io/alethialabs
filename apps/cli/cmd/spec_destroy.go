// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	specDestroySpecID   string
	specDestroyRunnerID string
	specDestroyWait     bool
)

var specDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a spec's infrastructure",
	Long:  `Queues a DESTROY job to tear down all cloud resources for a spec. This cannot be undone.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		zoneID := ""

		if specDestroySpecID == "" {
			zoneID, specDestroySpecID, err = selectZoneAndSpec(token)
			if err != nil {
				fail(err)
			}
		}

		if !confirm(
			"Are you sure you want to destroy this spec?",
			"This will tear down all cloud resources. It cannot be undone.",
		) {
			return
		}

		if specDestroyRunnerID == "" {
			specDestroyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DESTROY",
			ZoneID:          zoneID,
			ConfigurationID: specDestroySpecID,
		}
		if specDestroyRunnerID != "" {
			params.AssignedRunnerID = specDestroyRunnerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if specDestroyWait {
			ui.JobQueued("DESTROY", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("DESTROY", job.ID)
		}
	},
}

func init() {
	specCmd.AddCommand(specDestroyCmd)
	specDestroyCmd.Flags().StringVar(&specDestroySpecID, "spec-id", "", "ID of the spec to destroy")
	specDestroyCmd.Flags().StringVar(&specDestroyRunnerID, "runner-id", "", "Assign to a specific runner")
	specDestroyCmd.Flags().BoolVarP(&specDestroyWait, "wait", "w", false, "Wait for job completion")
}
