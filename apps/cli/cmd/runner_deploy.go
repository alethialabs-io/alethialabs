// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
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
	Short: fmt.Sprintf("Deploy a new runner to an %s cloud account", runners.DeployProvidersLabel()),
	Long: fmt.Sprintf(`Creates a runner record and queues a DEPLOY_RUNNER job using the latest stable release.

Deployed runners are %s only — Alethia holds runner infrastructure templates for no other
cloud. Everywhere else, register a runner you run yourself instead (Console → Runners →
Add runner → Register your own); it runs on any cloud. Omitting --cloud-identity-id lists
only the accounts a runner can be built into; passing one for another cloud is rejected by
the server before a runner or a job is created.`, runners.DeployProvidersLabel()),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		if deployCloudIdentityID == "" {
			// Deliberately NOT selectCloudIdentity: that lists EVERY linked cloud, which is right
			// for `project create` and wrong here. Only a cloud with a runner template can be
			// built into, and offering the rest is the defect #1794 names.
			deployCloudIdentityID, err = selectRunnerDeployCloudIdentity(token)
			if err != nil {
				fail(err)
			}
		}

		if deployRunnerName == "" {
			hostname, _ := os.Hostname()
			defaultName := fmt.Sprintf("runner-%s", hostname)

			err = runHuhForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Runner name").
						Value(&deployRunnerName).
						Placeholder(defaultName),
				),
			)
			if err != nil {
				fail(err)
			}

			if deployRunnerName == "" {
				deployRunnerName = defaultName
			}
		}

		if deployRegion == "" {
			err = runHuhForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Region").
						Description("Cloud region to deploy the runner into").
						Value(&deployRegion).
						Placeholder("eu-west-1"),
				),
			)
			if err != nil {
				fail(err)
			}

			if deployRegion == "" {
				deployRegion = "eu-west-1"
			}
		}

		if deployAssignedID == "" {
			deployAssignedID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		resp, err := apiClient.DeployRunner(deployRunnerName, deployCloudIdentityID, deployRegion, deployAssignedID)
		if err != nil {
			failf("Error: %v", err)
		}

		ui.Success(fmt.Sprintf("Runner %q created (ID: %s)", resp.Runner.Name, resp.Runner.ID))
		if deployRunnerWait {
			ui.JobQueued("DEPLOY_RUNNER", resp.Job.ID)
			if err := waitForJob(apiClient, resp.Job.ID); err != nil {
				exitFunc(1)
			}
		} else {
			ui.JobQueued("DEPLOY_RUNNER", resp.Job.ID)
		}
	},
}

func init() {
	runnerCmd.AddCommand(runnerDeployCmd)
	runnerDeployCmd.Flags().StringVar(&deployCloudIdentityID, "cloud-identity-id", "",
		fmt.Sprintf("Cloud identity to deploy into (%s only)", runners.DeployProvidersLabel()))
	runnerDeployCmd.Flags().StringVar(&deployRunnerName, "name", "", "Runner name")
	runnerDeployCmd.Flags().StringVar(&deployRegion, "region", "", "Cloud region")
	runnerDeployCmd.Flags().StringVar(&deployAssignedID, "assigned-runner-id", "", "Which runner executes the deployment")
	runnerDeployCmd.Flags().BoolVarP(&deployRunnerWait, "wait", "w", false, "Wait for job completion")
}
