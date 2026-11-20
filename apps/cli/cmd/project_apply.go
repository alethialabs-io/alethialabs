// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
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
	projectApplyWait       waitFlags
	// projectApplyYes is the --yes opt-in: deploy without being asked (and with --no-input).
	projectApplyYes bool
)

// projectDeployLong is the help of `project deploy`. The deprecated `project apply` shows it too.
const projectDeployLong = `Queue a DEPLOY job that creates or updates one environment of a project in your cloud account.

Use it after "alethia project preview" has shown you the changes. It asks before it queues
anything; pass --yes to skip the question, which a script or an agent must. The job runs on a
runner: add --wait to stay until it finishes, and --timeout to bound that wait. The job id is in
the result either way.

Nothing has to be copied out of another command's output: --project and --runner take a NAME,
and --latest-plan deploys the project's own most recent preview. --dry-run checks every input
and prints the request without sending it.

To create and deploy a whole project from an alethia.yaml file, use "alethia apply" instead.`

var projectDeployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy a project environment's infrastructure",
	Long:  projectDeployLong,
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runProjectDeploy(cmd, true); err != nil {
			fail(err)
		}
	},
}

// projectApplyCmd is the old name of `project deploy`, kept so a script written against it still
// runs. It is hidden, says so once on stderr, and keeps the contract it always had: it queues
// without asking. Asking is `project deploy`'s behaviour, and a script that never passed --yes
// must not start failing because the command it calls gained a second name.
var projectApplyCmd = &cobra.Command{
	Use:    "apply",
	Hidden: true,
	Short:  "Deprecated: use `alethia project deploy`",
	Long:   "Deprecated: this is the old name of `alethia project deploy`, which does the same thing.\n\n" + projectDeployLong,
	Args:   cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		renamedCommandNotice("project apply", "project deploy")
		if err := runProjectDeploy(cmd, false); err != nil {
			fail(err)
		}
	},
}

// renamedCommandNotice writes the one stderr line a deprecated command name prints.
func renamedCommandNotice(old, current string) {
	printer.Warn(fmt.Sprintf("`alethia %s` is now `alethia %s`. The old name still works and will be removed in a later release.", old, current))
}

// errDeployRequiresYes is the refusal of a deploy that nobody confirmed and nobody can be asked
// about.
var errDeployRequiresYes = refusal(clierr.CodeConfirmationRequired,
	"alethia project preview",
	"a deploy changes cloud resources and nothing can ask you to confirm it "+
		"(--no-input, stdin is not a terminal, or stderr is redirected): pass --yes to deploy")

// runProjectDeploy resolves and queues one DEPLOY job. confirmFirst is false only for the
// deprecated `project apply` name.
func runProjectDeploy(cmd *cobra.Command, confirmFirst bool) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)

	params, err := resolveProjectJobParams(client, token, projectJobInputs{
		JobType:    string(types.JobTypeDeploy),
		ProjectRef: projectApplyProjectRef, ProjectID: projectApplyProjectID,
		RunnerRef: projectApplyRunnerRef, RunnerID: projectApplyRunnerID,
		Env: projectApplyEnv,
	})
	if err != nil {
		return err
	}

	planJob, err := planJobToApply(client, params.ConfigurationID, projectApplyPlanJobID, projectApplyLatestPlan)
	if err != nil {
		return err
	}
	announceResolvedJob(planJob, "applying")
	params.PlanJobID = planJob.ID

	dryRun := cmdmeta.DryRunRequested(cmd)
	if confirmFirst && !dryRun && !projectApplyYes {
		if !canPromptForm() {
			return errDeployRequiresYes
		}
		if !confirm("Deploy this project environment?", deployDescription(params, projectApplyProjectRef, projectApplyEnv)) {
			return nil
		}
	}
	return finishProjectJob(cmd, client, projectJobRun{Params: params, Wait: projectApplyWait, DryRun: dryRun})
}

// deployDescription says what a deploy is about to do, for the confirmation: which project, which
// environment and which reviewed plan.
func deployDescription(params api.QueueJobParams, projectRef, env string) string {
	project := projectRef
	if project == "" {
		project = params.ConfigurationID
	}
	where := "the default environment"
	if env != "" {
		where = "environment " + env
	}
	plan := "It runs its own plan first."
	if params.PlanJobID != "" {
		plan = "It applies plan job " + params.PlanJobID + "."
	}
	return fmt.Sprintf("Queues a DEPLOY job for %s of project %s, which creates or changes cloud resources. %s",
		where, project, plan)
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
// queued — `project preview` then `project deploy --latest-plan`, with the plan still PROCESSING,
// would apply an OLDER one — and quietly applying a plan the operator did not review is exactly
// the handoff this removes, one step worse. So the most recent PLAN is the answer, and a refusal
// names it and its status.
func planJobToApply(c jobLister, projectID, id string, latest bool) (jobRef, error) {
	if id != "" && latest {
		return jobRef{}, refusal(clierr.CodeInvalidUsage, "",
			"--plan-job-id and --latest-plan both name the plan to apply: pass one "+
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
		return jobRef{}, refusal(clierr.CodeMissingArgument, "alethia project list",
			"--latest-plan needs a project: pass --project (by name or id)")
	}
	sel := jobSelector{jobType: string(types.JobTypePlan), project: projectID}
	matches, err := narrowJobs(c, sel, jobScope{})
	if err != nil {
		return jobRef{}, err
	}
	if len(matches) == 0 {
		return jobRef{}, refusal(clierr.CodeNotFound, "alethia project preview --wait",
			"--latest-plan: no PLAN job for this project in the last %d jobs — "+
				"queue one with `alethia project preview`, or name one with --plan-job-id",
			jobSelectorPageSize)
	}
	plan := matches[0]
	if !strings.EqualFold(plan.Status, string(types.JobStatusSuccess)) {
		return jobRef{}, refusal(clierr.CodeConflict, "alethia jobs get "+plan.ID,
			"--latest-plan: the most recent PLAN job for this project is %s and its status is %s — "+
				"a deploy may only apply a plan that SUCCEEDED, so wait for it or name another with --plan-job-id",
			plan.ID, plan.Status)
	}
	return jobRef{ID: plan.ID, Summary: jobOptionLabel(plan)}, nil
}

// registerDeployFlags registers the flags of `project deploy` on cmd. The deprecated `project
// apply` takes the same ones, bound to the same variables.
func registerDeployFlags(cmd *cobra.Command) {
	jobProjectFlags(cmd, &projectApplyProjectRef, &projectApplyProjectID, "deploy")
	jobRunnerFlags(cmd, &projectApplyRunnerRef, &projectApplyRunnerID)
	cmd.Flags().StringVar(&projectApplyPlanJobID, "plan-job-id", "", "Apply a prior PLAN job, by id (prefer --latest-plan)")
	cmd.Flags().BoolVar(&projectApplyLatestPlan, "latest-plan", false,
		"Apply the project's most recent PLAN job instead of naming one (works with --no-input)")
	cmd.Flags().StringVar(&projectApplyEnv, "env", "", jobEnvFlagUsage)
	addProjectWaitFlags(cmd, &projectApplyWait)
	addDryRunFlag(cmd)
	cmd.Flags().BoolVarP(&projectApplyYes, "yes", "y", false, "Deploy without being asked first (required with --no-input)")
}

func init() {
	projectCmd.AddCommand(projectDeployCmd)
	projectCmd.AddCommand(projectApplyCmd)
	registerDeployFlags(projectDeployCmd)
	registerDeployFlags(projectApplyCmd)
}
