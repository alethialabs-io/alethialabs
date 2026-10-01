// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	projectDestroyProjectRef string
	projectDestroyProjectID  string
	projectDestroyRunnerID   string
	projectDestroyEnv        string
	projectDestroyWait       bool
	// projectDestroyYes is the --yes opt-in: skip the confirmation prompt (and make
	// the command usable with --no-input).
	projectDestroyYes bool
	// projectDestroyCascade is the --cascade opt-in (#5249): also destroy every environment placed
	// on the target's Fabric, tenants first. Without it the server refuses to destroy an environment
	// that owns a cluster other live environments still run in.
	projectDestroyCascade bool
)

// destroyTreeClient is what `project destroy --cascade` needs from the control plane before it
// queues anything: the tree it is about to destroy.
type destroyTreeClient interface {
	GetDestroyTree(project, envID string) ([]api.DestroyTreeNode, error)
}

var projectDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a project's infrastructure",
	Long: `Queues a DESTROY job to tear down all cloud resources for a project environment. This cannot be undone.

An environment placed as "dedicated" owns its cluster. While other environments (namespace or
vcluster placements) are still placed on that cluster, destroying it is refused, naming them:
destroy them first, or pass --cascade. --cascade prints every environment it will destroy, in
order — the tenants first, the cluster's owner last — and asks before it queues anything.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		projectDestroyProjectID, err = projectIDForJob(api.NewClient(token), token, projectDestroyProjectRef, projectDestroyProjectID)
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)

		// Resolved BEFORE the confirmation, so the question is asked about a real environment and
		// --cascade can show what that environment's destroy takes with it.
		envID, err := resolveEnvironmentID(apiClient, projectDestroyProjectID, projectDestroyEnv)
		if err != nil {
			fail(err)
		}

		title := "Are you sure you want to destroy this project?"
		description := "This will tear down all cloud resources. It cannot be undone."
		if projectDestroyCascade {
			order, err := destroyTreeSummary(apiClient, projectDestroyProjectID, envID)
			if err != nil {
				fail(err)
			}
			// Printed, not only put in the dialog: with --yes there is no dialog, and the log of a
			// scripted teardown should still say what it tore down.
			fmt.Println(order)
			title = "Destroy all of these environments?"
			description = order + "\nThis will tear down their cloud resources. It cannot be undone."
		}

		if !confirmDestructive(projectDestroyYes, title, description) {
			return
		}

		// The runner picker cannot be answered with prompting disabled, and the
		// assignment is optional — an empty id is the picker's own "Any available"
		// default — so a scripted teardown simply leaves the job unassigned.
		if projectDestroyRunnerID == "" && canPromptForm() {
			projectDestroyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		params := api.QueueJobParams{
			JobType:         "DESTROY",
			ConfigurationID: projectDestroyProjectID,
			EnvironmentID:   envID,
			Cascade:         projectDestroyCascade,
		}
		if projectDestroyRunnerID != "" {
			params.AssignedRunnerID = projectDestroyRunnerID
		}

		resp, err := apiClient.QueueJobFull(params)
		if err != nil {
			fail(destroyQueueError(err, projectDestroyCascade))
			return
		}

		queued := queuedDestroyJobs(resp)
		for _, j := range queued {
			ui.JobQueued("DESTROY", j.JobID)
		}

		if projectDestroyWait {
			if err := waitForDestroyJobs(apiClient, projectDestroyProjectID, queued); err != nil {
				ui.Error(err.Error())
				exitFunc(1)
			}
		}
	},
}

// destroyTreeSummary fetches the destroy tree of envID and renders it as one line:
// "Will destroy, in order: dev-1 (namespace), staging (vcluster), prod (dedicated, owns the cluster)".
func destroyTreeSummary(client destroyTreeClient, projectID, envID string) (string, error) {
	tree, err := client.GetDestroyTree(projectID, envID)
	if err != nil {
		return "", err
	}
	if len(tree) == 0 {
		return "", errors.New("the control plane returned an empty destroy tree")
	}
	return renderDestroyTree(tree), nil
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
func destroyQueueError(err error, cascade bool) error {
	var apiErr *api.APIError
	if !cascade && errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusConflict &&
		strings.Contains(apiErr.Message, "cascade") {
		return fmt.Errorf("%w\nRe-run with --cascade to see every environment it would destroy and confirm", err)
	}
	return err
}

// queuedDestroyJobs is every job one destroy queued, in destroy order. A plain destroy queued one —
// the response's `job`; a cascade lists them all in `cascade_jobs`, owner last.
func queuedDestroyJobs(resp *api.QueueJobResponse) []api.CascadeJob {
	if len(resp.CascadeJobs) > 0 {
		return resp.CascadeJobs
	}
	if resp.Job == nil {
		return nil
	}
	return []api.CascadeJob{{JobID: resp.Job.ID}}
}

// waitForDestroyJobs waits for every queued job, in destroy order. The owner's DESTROY is held by
// the control plane until its tenants are gone, so when a TENANT's destroy fails the owner's job
// does not fail — it stays QUEUED, waiting. This says so, and names the two ways out, rather than
// polling a job that will not start.
func waitForDestroyJobs(poller jobPoller, projectID string, queued []api.CascadeJob) error {
	for i, j := range queued {
		if err := waitForJob(poller, j.JobID); err != nil {
			rest := queued[i+1:]
			if len(rest) == 0 {
				return err
			}
			owner := rest[len(rest)-1]
			name := j.Name
			if name == "" {
				name = "job " + j.JobID
			}
			return fmt.Errorf(
				"the destroy of %s did not succeed (%v). %s's DESTROY (job %s) stays QUEUED and will not start while %s is still placed on its cluster: fix it and destroy %s again (alethia project destroy --project %s --env %s), or cancel the waiting job (alethia jobs cancel %s)",
				name, err, owner.Name, owner.JobID, name, name, projectID, name, owner.JobID,
			)
		}
	}
	return nil
}

func init() {
	addYesFlag(projectDestroyCmd, &projectDestroyYes)
	projectCmd.AddCommand(projectDestroyCmd)
	jobProjectFlags(projectDestroyCmd, &projectDestroyProjectRef, &projectDestroyProjectID, "destroy")
	projectDestroyCmd.Flags().StringVar(&projectDestroyRunnerID, "runner-id", "", "Assign to a specific runner")
	projectDestroyCmd.Flags().StringVar(&projectDestroyEnv, "env", "", "Target environment name (default: the project's default environment)")
	projectDestroyCmd.Flags().BoolVarP(&projectDestroyWait, "wait", "w", false, "Wait for job completion (with --cascade, for every job)")
	projectDestroyCmd.Flags().BoolVar(&projectDestroyCascade, "cascade", false, "Also destroy the environments placed on this environment's cluster, tenants first; prints them all and confirms first")
}
