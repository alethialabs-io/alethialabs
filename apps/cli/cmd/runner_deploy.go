// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	deployCloudIdentityID string
	deployRunnerName      string
	deployRegion          string
	deployAssignedID      string
	deployRunnerWait      bool
)

var runnerDeployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy a new runner to a cloud account",
	Long:  `Creates a runner record and queues a DEPLOY_RUNNER job using the latest stable release.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		if deployCloudIdentityID == "" {
			deployCloudIdentityID, err = selectCloudIdentity(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		if deployRunnerName == "" {
			hostname, _ := os.Hostname()
			defaultName := fmt.Sprintf("runner-%s", hostname)

			err = huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Runner name").
						Value(&deployRunnerName).
						Placeholder(defaultName),
				),
			).Run()
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			if deployRunnerName == "" {
				deployRunnerName = defaultName
			}
		}

		if deployRegion == "" {
			err = huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Region").
						Description("Cloud region to deploy the runner into").
						Value(&deployRegion).
						Placeholder("eu-west-1"),
				),
			).Run()
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			if deployRegion == "" {
				deployRegion = "eu-west-1"
			}
		}

		if deployAssignedID == "" {
			deployAssignedID, err = selectRunner(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		resp, err := apiClient.DeployRunner(deployRunnerName, deployCloudIdentityID, deployRegion, deployAssignedID)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		ui.Success(fmt.Sprintf("Runner %q created (ID: %s)", resp.Runner.Name, resp.Runner.ID))
		if deployRunnerWait {
			ui.JobQueued("DEPLOY_RUNNER", resp.Job.ID)
			if err := waitForJob(apiClient, resp.Job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("DEPLOY_RUNNER", resp.Job.ID)
		}
	},
}

func init() {
	runnerCmd.AddCommand(runnerDeployCmd)
	runnerDeployCmd.Flags().StringVar(&deployCloudIdentityID, "cloud-identity-id", "", "Cloud identity to deploy into")
	runnerDeployCmd.Flags().StringVar(&deployRunnerName, "name", "", "Runner name")
	runnerDeployCmd.Flags().StringVar(&deployRegion, "region", "", "Cloud region")
	runnerDeployCmd.Flags().StringVar(&deployAssignedID, "assigned-runner-id", "", "Which runner executes the deployment")
	runnerDeployCmd.Flags().BoolVarP(&deployRunnerWait, "wait", "w", false, "Wait for job completion")
}
