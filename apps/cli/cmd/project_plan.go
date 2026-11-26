// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var (
	projectPlanProjectRef string
	projectPlanProjectID  string
	projectPlanRunnerRef  string
	projectPlanRunnerID   string
	projectPlanEnv        string
	projectPlanWait       waitFlags
	// projectPlanDestroy is --destroy (#7455): plan a teardown of the environment instead of an
	// apply. Nothing is destroyed; `project destroy` is then approved against this plan.
	projectPlanDestroy bool
)

// projectPreviewLong is the help of `project preview`. The deprecated `project plan` shows it too.
const projectPreviewLong = `Queue a PLAN job that works out what a deploy would change in one environment of a project, with a cost estimate, and changes nothing in your cloud account.

Use it before "alethia project deploy" to read the changes first. The job runs on a runner: add
--wait to stay until it finishes and --timeout to bound that wait, then read the plan with
"alethia jobs logs". "alethia project deploy --latest-plan" deploys exactly the plan you read.

--destroy plans a teardown of the environment instead: what "alethia project destroy" would
delete. It deletes nothing. A destroy from the CLI is approved against a destroy plan, and
"alethia project destroy --latest-plan" asks for the approval of exactly the plan you read.
"project deploy --latest-plan" never picks a destroy plan.

--project and --runner take a NAME, so nothing has to be copied out of another command's
output. --dry-run checks every input and prints the request without sending it.

This is not "alethia plan", which compares an alethia.yaml file with a project and queues nothing.`

var projectPreviewCmd = &cobra.Command{
	Use:   "preview",
	Short: "Preview what a deploy would change",
	Long:  projectPreviewLong,
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runProjectPreview(cmd); err != nil {
			fail(err)
		}
	},
}

// projectPlanCmd is the old name of `project preview`, kept so a script written against it still
// runs. It is hidden and says so once on stderr.
var projectPlanCmd = &cobra.Command{
	Use:    "plan",
	Hidden: true,
	Short:  "Deprecated: use `alethia project preview`",
	Long:   "Deprecated: this is the old name of `alethia project preview`, which does the same thing.\n\n" + projectPreviewLong,
	Args:   cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		renamedCommandNotice("project plan", "project preview")
		if err := runProjectPreview(cmd); err != nil {
			fail(err)
		}
	},
}

// runProjectPreview resolves and queues one PLAN job.
func runProjectPreview(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)

	params, err := resolveProjectJobParams(client, token, projectJobInputs{
		JobType:    string(types.JobTypePlan),
		ProjectRef: projectPlanProjectRef, ProjectID: projectPlanProjectID,
		RunnerRef: projectPlanRunnerRef, RunnerID: projectPlanRunnerID,
		Env: projectPlanEnv,
	})
	if err != nil {
		return err
	}
	params.DestroyPlan = projectPlanDestroy
	return finishProjectJob(cmd, client, projectJobRun{
		Params: params, Wait: projectPlanWait, DryRun: cmdmeta.DryRunRequested(cmd),
	})
}

// registerPreviewFlags registers the flags of `project preview` on cmd. The deprecated `project
// plan` takes the same ones, bound to the same variables.
func registerPreviewFlags(cmd *cobra.Command) {
	jobProjectFlags(cmd, &projectPlanProjectRef, &projectPlanProjectID, "preview")
	jobRunnerFlags(cmd, &projectPlanRunnerRef, &projectPlanRunnerID)
	cmd.Flags().StringVar(&projectPlanEnv, "env", "", jobEnvFlagUsage)
	addProjectWaitFlags(cmd, &projectPlanWait)
	addDryRunFlag(cmd)
	cmd.Flags().BoolVar(&projectPlanDestroy, "destroy", false,
		"Plan a teardown of the environment instead of a deploy; deletes nothing (what `project destroy` is approved against)")
}

func init() {
	projectCmd.AddCommand(projectPreviewCmd)
	projectCmd.AddCommand(projectPlanCmd)
	registerPreviewFlags(projectPreviewCmd)
	registerPreviewFlags(projectPlanCmd)
}
