// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var (
	projectDestroyProjectRef string
	projectDestroyProjectID  string
	projectDestroyRunnerRef  string
	projectDestroyRunnerID   string
	projectDestroyEnv        string
	projectDestroyWait       waitFlags
	// projectDestroyYes is the --yes opt-in: skip the confirmation prompt (and make
	// the command usable with --no-input).
	projectDestroyYes bool
	// projectDestroyCascade is the --cascade opt-in (#5249): also destroy every environment placed
	// on the target's Fabric, tenants first. Without it the server refuses to destroy an environment
	// that owns a cluster other live environments still run in.
	projectDestroyCascade bool
	// projectDestroyNoWait is --no-wait: when the destroy needs a person's approval, print where to
	// give it and exit 9 instead of waiting.
	projectDestroyNoWait bool
)

// destroyTreeClient is what `project destroy --cascade` needs from the control plane before it
// queues anything: the tree it is about to destroy.
type destroyTreeClient interface {
	GetDestroyTree(project, envID string) ([]api.DestroyTreeNode, error)
}

var projectDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a project environment's infrastructure",
	Long: `Queue a DESTROY job that tears down every cloud resource of one environment of a project. This cannot be undone.

Use it when an environment is finished with. On a terminal you confirm by typing the project's
name; a script or an agent passes --yes, and without it the command refuses and exits 9. Add
--wait to stay until the job finishes and --timeout to bound that wait. --dry-run checks every
input and prints the request without sending it.

An environment placed as "dedicated" owns its cluster. While other environments (namespace or
vcluster placements) are still placed on that cluster, destroying it is refused, naming them:
destroy them first, or pass --cascade. --cascade prints every environment it will destroy, in
order — the tenants first, the cluster's owner last — and asks before it queues anything.

A destroy from the CLI needs a person's approval, given against the plan the environment's current
state was deployed from. The control plane says so when the destroy is sent; the command then
asks for an approval, prints the console page where a person approves it and the plan digest that
page must show, and waits for the decision before it queues the destroy. --no-wait (and agent
mode) prints the page and exits 9 instead; run the same destroy again once it is approved. A
rejected approval exits 5, an expired or superseded one 7. A --cascade destroy is never approved
this way: start it from the console.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runProjectDestroy(cmd); err != nil {
			fail(err)
		}
	},
}

// destroyClient is what `project destroy` reads before it queues: the references, the destroy
// tree and the project's name.
type destroyClient interface {
	projectJobResolver
	projectJobClient
	destroyTreeClient
	jobLister
	approvalClient
}

// runProjectDestroy resolves, confirms and queues one DESTROY, or a cascade of them.
func runProjectDestroy(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	return destroyProject(cmd, api.NewClient(token), token)
}

// destroyProject is runProjectDestroy after authentication.
func destroyProject(cmd *cobra.Command, client destroyClient, token string) error {
	params, err := resolveProjectJobParams(client, token, projectJobInputs{
		JobType:    string(types.JobTypeDestroy),
		ProjectRef: projectDestroyProjectRef, ProjectID: projectDestroyProjectID,
		RunnerRef: projectDestroyRunnerRef, RunnerID: projectDestroyRunnerID,
		Env: projectDestroyEnv,
	})
	if err != nil {
		return err
	}
	params.Cascade = projectDestroyCascade
	run := projectJobRun{Params: params, Wait: projectDestroyWait, DryRun: cmdmeta.DryRunRequested(cmd)}
	if !projectDestroyCascade {
		// A cascade is refused for want of an approval in any case: one approval covers one
		// environment, so the control plane's refusal is passed through as it is.
		run.Approval = &projectJobApproval{
			Client:    client,
			Operation: api.ApprovalOperationDestroy,
			PlanJobID: func() (string, error) { return appliedPlanJobID(client, params.ConfigurationID, params.EnvironmentID) },
			Wait:      approvalWait{NoWait: projectDestroyNoWait, Timeout: projectDestroyWait.Timeout},
		}
	}

	title := "Destroy this project environment?"
	description := "This tears down all of its cloud resources. It cannot be undone."
	if projectDestroyCascade {
		// Read BEFORE the confirmation, so the question is asked about the real set of
		// environments this destroy takes with it.
		if run.Tree, err = destroyTree(client, params.ConfigurationID, params.EnvironmentID); err != nil {
			return err
		}
		order := renderDestroyTree(run.Tree)
		// Printed, not only put in the dialog: with --yes there is no dialog, and the log of a
		// scripted teardown should still say what it tore down.
		fmt.Fprintln(printer.Err, order)
		title = "Destroy all of these environments?"
		description = order + "\nThis tears down their cloud resources. It cannot be undone."
	}

	if !run.DryRun {
		ok, err := confirmDestructiveByName(projectDestroyYes, title, description, func() string {
			return projectConfirmName(client, params.ConfigurationID)
		})
		if err != nil || !ok {
			return err
		}
	}

	return destroyQueueError(finishProjectJob(cmd, client, run), projectDestroyCascade)
}

// appliedPlanJobID names the plan an environment's current state was deployed from, which is the
// plan a destroy's approval is given against: the plan of the environment's most recent successful
// DEPLOY. envID empty is the project's default environment.
//
// The jobs list does not carry a job's environment, so a DEPLOY is matched on the environment id its
// frozen config snapshot records. Only the most recent page of jobs is read; a deploy older than
// that is not found, and the refusal says where the destroy can be started instead.
func appliedPlanJobID(c interface {
	envLister
	jobLister
}, projectID, envID string) (string, error) {
	if envID == "" {
		envs, err := c.ListEnvironments(projectID)
		if err != nil {
			return "", fmt.Errorf("find the environment this destroy needs an approval for: %w", err)
		}
		for _, e := range envs {
			if e.IsDefault {
				envID = e.ID
			}
		}
	}
	deploys, err := narrowJobs(c, jobSelector{
		jobType: string(types.JobTypeDeploy), status: string(types.JobStatusSuccess), project: projectID,
	}, jobScope{})
	if err != nil {
		return "", err
	}
	// Newest first, and only the newest counts: it is the deploy the environment's state came from.
	// One with no plan (a system re-apply) cannot be approved against, so the search stops there.
	for _, d := range deploys {
		if envID != "" && d.ConfigSnapshot["environment_id"] == envID {
			if d.PlanJobID != "" {
				return d.PlanJobID, nil
			}
			break
		}
	}
	return "", refusal(clierr.CodeApprovalRequired, "destroy it from the console, where your click is the approval",
		"this destroy needs a person's approval, given against the plan the environment was deployed from, "+
			"and no successful deploy of it with a plan is among the last %d jobs", jobSelectorPageSize)
}

// projectConfirmName is what the person types to confirm a destroy: the project's name, or its id
// when the project list cannot supply a name.
func projectConfirmName(c projectLister, id string) string {
	configs, _ := c.GetConfigurations()
	for _, cfg := range configs {
		if cfg.ID == id && cfg.ProjectName != "" {
			return cfg.ProjectName
		}
	}
	return id
}

// destroyTree fetches the destroy tree of envID, refusing an empty one: there would be nothing to
// show the person who is about to confirm.
func destroyTree(client destroyTreeClient, projectID, envID string) ([]api.DestroyTreeNode, error) {
	tree, err := client.GetDestroyTree(projectID, envID)
	if err != nil {
		return nil, fmt.Errorf("read what this destroy takes with it: %w", err)
	}
	if len(tree) == 0 {
		return nil, refusal(clierr.CodeInternal, "",
			"the control plane returned an empty destroy tree, so there is nothing to confirm")
	}
	return tree, nil
}

// renderDestroyTree renders a destroy tree in destroy order. Each environment is named with its
// placement, the cluster's owner says so, and any environment not in a settled state shows its
// status — a FAILED tenant is exactly the one an operator needs to see before confirming.
func renderDestroyTree(tree []api.DestroyTreeNode) string {
	parts := make([]string, 0, len(tree))
	for _, n := range tree {
		detail := []string{n.PlacementMode}
		if n.OwnsFabric {
			detail = append(detail, "owns the cluster")
		}
		if n.Status != "ACTIVE" && n.Status != "" {
			detail = append(detail, strings.ToLower(n.Status))
		}
		parts = append(parts, fmt.Sprintf("%s (%s)", n.Name, strings.Join(detail, ", ")))
	}
	if len(tree) == 1 {
		return "Nothing else is placed on this environment's cluster. Will destroy: " + parts[0]
	}
	return "Will destroy, in order: " + strings.Join(parts, ", ")
}

// destroyQueueError adds the way out to a refused destroy. The server's 409 already names every
// tenant; the CLI adds the flag that cascades, which the server cannot know is called --cascade.
// The error keeps the class the control plane's answer gave it.
func destroyQueueError(err error, cascade bool) error {
	var apiErr *api.APIError
	if !cascade && errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusConflict &&
		strings.Contains(apiErr.Message, "cascade") {
		e := *clierr.From(err)
		e.Hint = "re-run with --cascade to see every environment it would destroy, and confirm"
		return &e
	}
	return err
}

func init() {
	addYesFlag(projectDestroyCmd, &projectDestroyYes)
	projectCmd.AddCommand(projectDestroyCmd)
	jobProjectFlags(projectDestroyCmd, &projectDestroyProjectRef, &projectDestroyProjectID, "destroy")
	jobRunnerFlags(projectDestroyCmd, &projectDestroyRunnerRef, &projectDestroyRunnerID)
	projectDestroyCmd.Flags().StringVar(&projectDestroyEnv, "env", "", jobEnvFlagUsage)
	addProjectWaitFlags(projectDestroyCmd, &projectDestroyWait)
	addDryRunFlag(projectDestroyCmd)
	projectDestroyCmd.Flags().BoolVar(&projectDestroyCascade, "cascade", false, "Also destroy the environments placed on this environment's cluster, tenants first; prints them all and confirms first")
	addApprovalNoWaitFlag(projectDestroyCmd, &projectDestroyNoWait)
}
