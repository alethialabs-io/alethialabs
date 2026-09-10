// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	projectPlanProjectRef string
	projectPlanProjectID  string
	projectPlanRunnerRef  string
	projectPlanRunnerID   string
	projectPlanEnv        string
	projectPlanWait       bool
)

var projectPlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "Queue a plan (dry-run) job for a project",
	Long: `Plan runs a Terraform plan with cost analysis without applying changes.

--runner takes a runner's NAME, so nothing has to be copied out of ` + "`alethia runner list`" + `.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)

		projectPlanProjectID, err = projectIDForJob(apiClient, token, projectPlanProjectRef, projectPlanProjectID)
		if err != nil {
			fail(err)
		}

		projectPlanRunnerID, err = runnerIDFrom(
			apiClient, projectPlanRunnerRef, projectPlanRunnerID, "--runner", "--runner-id")
		if err != nil {
			fail(err)
		}

		// The runner picker cannot be answered with prompting disabled, and the assignment is
		// OPTIONAL — an empty id is the picker's own "Any available" default — so a scripted
		// run simply leaves the job unassigned. Without this guard `--no-input` could not queue
		// a PLAN at all without also naming a runner, which is a flag for a field the command
		// does not require. `project destroy` already had it; these two did not.
		if projectPlanRunnerID == "" && canPromptForm() {
			projectPlanRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		envID, err := resolveEnvironmentID(apiClient, projectPlanProjectID, projectPlanEnv)
		if err != nil {
			fail(err)
		}

		params := api.QueueJobParams{
			JobType:         "PLAN",
			ConfigurationID: projectPlanProjectID,
			EnvironmentID:   envID,
		}
		if projectPlanRunnerID != "" {
			params.AssignedRunnerID = projectPlanRunnerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectPlanWait {
			ui.JobQueued("PLAN", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				exitFunc(1)
			}
		} else {
			ui.JobQueued("PLAN", job.ID)
		}
	},
}

func init() {
	projectCmd.AddCommand(projectPlanCmd)
	jobProjectFlags(projectPlanCmd, &projectPlanProjectRef, &projectPlanProjectID, "plan")
	// TWO flags for one field, for the reason jobProjectFlags states about --project /
	// --project-id: `--runner-id` is what scripts already pass and keeps working, `--runner` is
	// the one a person uses and is the spelling `alethia apply --runner` already had. Passing
	// both is refused rather than resolved by precedence — see runnerIDFrom.
	projectPlanCmd.Flags().StringVar(&projectPlanRunnerRef, "runner", "",
		"Runner to run this job on, by NAME or id (asked for on a terminal when omitted)")
	projectPlanCmd.Flags().StringVar(&projectPlanRunnerID, "runner-id", "",
		"Runner id to assign (prefer --runner, which also takes the name)")
	projectPlanCmd.Flags().StringVar(&projectPlanEnv, "env", "", "Target environment name (default: the project's default environment)")
	projectPlanCmd.Flags().BoolVarP(&projectPlanWait, "wait", "w", false, "Wait for job completion")
}
