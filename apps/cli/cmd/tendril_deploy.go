// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var (
	deployCloudIdentityID string
	deployTendrilName     string
	deployRegion          string
	deployAssignedID      string
	deployTendrilWait     bool
)

var tendrilDeployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy a new runner to a cloud account",
	Long:  `Creates a runner record and queues a DEPLOY_WORKER job using the latest stable release.`,
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

		if deployTendrilName == "" {
			hostname, _ := os.Hostname()
			defaultName := fmt.Sprintf("tendril-%s", hostname)

			err = huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Runner name").
						Value(&deployTendrilName).
						Placeholder(defaultName),
				),
			).Run()
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			if deployTendrilName == "" {
				deployTendrilName = defaultName
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
			deployAssignedID, err = selectTendril(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		resp, err := apiClient.DeployTendril(deployTendrilName, deployCloudIdentityID, deployRegion, deployAssignedID)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		ui.Success(fmt.Sprintf("Tendril %q created (ID: %s)", resp.Tendril.Name, resp.Tendril.ID))
		if deployTendrilWait {
			ui.JobQueued("DEPLOY_WORKER", resp.Job.ID)
			if err := waitForJob(apiClient, resp.Job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("DEPLOY_WORKER", resp.Job.ID)
		}
	},
}

func init() {
	tendrilCmd.AddCommand(tendrilDeployCmd)
	tendrilDeployCmd.Flags().StringVar(&deployCloudIdentityID, "cloud-identity-id", "", "Cloud identity to deploy into")
	tendrilDeployCmd.Flags().StringVar(&deployTendrilName, "name", "", "Runner name")
	tendrilDeployCmd.Flags().StringVar(&deployRegion, "region", "", "Cloud region")
	tendrilDeployCmd.Flags().StringVar(&deployAssignedID, "assigned-runner-id", "", "Which runner executes the deployment")
	tendrilDeployCmd.Flags().BoolVarP(&deployTendrilWait, "wait", "w", false, "Wait for job completion")
}
