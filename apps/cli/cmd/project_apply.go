// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var (
	projectApplyProjectRef string
	projectApplyProjectID  string
	projectApplyRunnerRef  string
	projectApplyRunnerID   string
	projectApplyPlanJobID  string
	projectApplyLatestPlan bool
	projectApplyEnv        string
	projectApplyWait       bool
)

var projectApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply infrastructure changes for a project",
	Long: `Queues a DEPLOY job to provision or update a project's infrastructure.

Nothing has to be copied out of another command's output: --runner takes a runner's
NAME, and --latest-plan applies the project's own most recent PLAN job instead of a
uuid pasted from ` + "`alethia jobs get`" + `.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)

		projectApplyProjectID, err = projectIDForJob(apiClient, token, projectApplyProjectRef, projectApplyProjectID)
		if err != nil {
			fail(err)
		}

		projectApplyRunnerID, err = runnerIDFrom(
			apiClient, projectApplyRunnerRef, projectApplyRunnerID, "--runner", "--runner-id")
		if err != nil {
			fail(err)
		}

		// The runner picker cannot be answered with prompting disabled, and the assignment is
		// OPTIONAL — an empty id is the picker's own "Any available" default — so a scripted
		// run simply leaves the job unassigned. Without this guard `--no-input` could not queue
		// a DEPLOY at all without also naming a runner, which is a flag for a field the command
		// does not require. `project destroy` already had it; these two did not.
		if projectApplyRunnerID == "" && canPromptForm() {
			projectApplyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		planJob, err := planJobToApply(
			apiClient, projectApplyProjectID, projectApplyPlanJobID, projectApplyLatestPlan)
		if err != nil {
			fail(err)
		}
		announceResolvedJob(planJob, "applying")

		envID, err := resolveEnvironmentID(apiClient, projectApplyProjectID, projectApplyEnv)
		if err != nil {
			fail(err)
		}

		params := api.QueueJobParams{
			JobType:         "DEPLOY",
			ConfigurationID: projectApplyProjectID,
			EnvironmentID:   envID,
		}
		if projectApplyRunnerID != "" {
			params.AssignedRunnerID = projectApplyRunnerID
		}
		if planJob.ID != "" {
			params.PlanJobID = planJob.ID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectApplyWait {
			ui.JobQueued("DEPLOY", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				exitFunc(1)
			}
		} else {
			ui.JobQueued("DEPLOY", job.ID)
		}
	},
}

// planJobToApply answers "which PLAN job does this deploy apply" from the two inputs that can
// name one: the id a caller already holds, or `--latest-plan`.
//
// It returns a jobRef, so the CHOSEN case carries a summary and the NAMED case does not —
// announceResolvedJob prints one and stays silent about the other. A CLI that picked a job for
// you and did not say which is the failure resolveProjectName records: a silent pass-through
// that reads as success.
//
// An empty ref (neither input given) is the untouched behaviour and the common one: the DEPLOY
// runs its own plan. That default is deliberately NOT "resolve the latest PLAN anyway", and the
// reason is measured rather than stylistic — `plan_job_id` is not a hint, it is a MODE:
//
//   - the runner refuses a DEPLOY whose plan job is not SUCCESS, and refuses it again when the
//     configuration hash moved since (apps/runner/internal/agent/runner.go), so a silently
//     attached plan turns a working apply into a failing one;
//   - the console's build-then-deploy routing is gated on `!planJobId`
//     (apps/console/app/server/actions/projects.ts), so attaching one silently stops chaining
//     the BUILD for repo-sourced services on an ACTIVE environment.
//
// Both of those are what `--plan-job-id` is FOR when a caller asks for it, and neither is
// something to hand a caller who did not.
//
// THE `--type PLAN` NARROWING IS THE POINT, not a detail. "The project's most recent job" is as
// likely to be the DEPLOY that followed the plan as the plan itself, and applying a DEPLOY job's
// id as a plan reference is a wrong answer the command reports as success. The narrowing is the
// selector spec's own `--type` field, reused rather than re-matched, so it cannot come to
// disagree with what `alethia jobs get --latest --type PLAN` means.
//
// The STATUS is checked and never used to narrow, which is the opposite choice and also
// deliberate. Skipping a non-SUCCESS plan would silently reach PAST the plan the caller just
// queued — `project plan` then `project apply --latest-plan`, with the plan still PROCESSING,
// would apply an OLDER one — and quietly applying a plan the operator did not review is exactly
// the handoff this removes, one step worse. So the most recent PLAN is the answer, and a refusal
// names it and its status.
func planJobToApply(c jobLister, projectID, id string, latest bool) (jobRef, error) {
	if id != "" && latest {
		return jobRef{}, fmt.Errorf(
			"--plan-job-id and --latest-plan both name the plan to apply: pass one " +
				"(--latest-plan takes the project's most recent PLAN job)")
	}
	if !latest {
		return jobRef{ID: id}, nil
	}
	if projectID == "" {
		// Without a project the narrowing below drops the project field entirely — `set()` keeps
		// only non-empty fields, so `--type PLAN` is the only filter left and the match is every
		// PLAN job in the org. `--latest-plan` would then resolve another project's plan and the
		// deploy would fail on a hash mismatch a long way from the cause.
		return jobRef{}, fmt.Errorf("--latest-plan needs a project: pass --project (by name or id)")
	}
	sel := jobSelector{jobType: string(types.JobTypePlan), project: projectID}
	matches, err := narrowJobs(c, sel, jobScope{})
	if err != nil {
		return jobRef{}, err
	}
	if len(matches) == 0 {
		return jobRef{}, fmt.Errorf(
			"--latest-plan: no PLAN job for this project in the last %d jobs — "+
				"queue one with `alethia project plan`, or name one with --plan-job-id",
			jobSelectorPageSize)
	}
	plan := matches[0]
	if !strings.EqualFold(plan.Status, string(types.JobStatusSuccess)) {
		return jobRef{}, fmt.Errorf(
			"--latest-plan: the most recent PLAN job for this project is %s and its status is %s — "+
				"a deploy may only apply a plan that SUCCEEDED, so wait for it or name another with --plan-job-id",
			plan.ID, plan.Status)
	}
	return jobRef{ID: plan.ID, Summary: jobOptionLabel(plan)}, nil
}

func init() {
	projectCmd.AddCommand(projectApplyCmd)
	jobProjectFlags(projectApplyCmd, &projectApplyProjectRef, &projectApplyProjectID, "deploy")
	// TWO flags for one field, for the reason jobProjectFlags states about --project /
	// --project-id: `--runner-id` is what scripts already pass and keeps working, `--runner` is
	// the one a person uses and is the spelling `alethia apply --runner` already had. Passing
	// both is refused rather than resolved by precedence — see runnerIDFrom.
	projectApplyCmd.Flags().StringVar(&projectApplyRunnerRef, "runner", "",
		"Runner to run this job on, by NAME or id (asked for on a terminal when omitted)")
	projectApplyCmd.Flags().StringVar(&projectApplyRunnerID, "runner-id", "",
		"Runner id to assign (prefer --runner, which also takes the name)")
	projectApplyCmd.Flags().StringVar(&projectApplyPlanJobID, "plan-job-id", "", "Reference a prior PLAN job by id (prefer --latest-plan)")
	projectApplyCmd.Flags().BoolVar(&projectApplyLatestPlan, "latest-plan", false,
		"Apply the project's most recent PLAN job instead of naming one (works with --no-input)")
	projectApplyCmd.Flags().StringVar(&projectApplyEnv, "env", "", "Target environment name (default: the project's default environment)")
	projectApplyCmd.Flags().BoolVarP(&projectApplyWait, "wait", "w", false, "Wait for job completion")
}
