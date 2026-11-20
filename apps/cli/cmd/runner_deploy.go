// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/spf13/cobra"
)

var (
	deployCloudAccount    string
	deployCloudIdentityID string
	deployRunnerName      string
	deployRegion          string
	deployAssignedRunner  string
	deployAssignedID      string
	// deployRunnerWait is --wait and --timeout.
	deployRunnerWait waitFlags
)

// runnerDeployJobType is the job a runner deploy queues.
const runnerDeployJobType = "DEPLOY_RUNNER"

// deployRegionDefault is the region a deploy falls back to — the value the interactive form
// already offers as its placeholder, so pressing Enter through the form and running with
// --no-input land in the same place.
const deployRegionDefault = "eu-west-1"

// deployHostname is os.Hostname, as a seam. Measured, not assumed: os.Hostname does not fail on
// this machine or in CI, so the empty arm below is unreachable from a test without it — and that
// arm is the one that decides whether a scripted deploy is named `runner-` or `runner`.
var deployHostname = os.Hostname

// deployDefaultName is the runner name a deploy falls back to. Derived from the hostname of the
// machine that asked for the deploy, which is what the form has always offered.
func deployDefaultName() string {
	hostname, err := deployHostname()
	if err != nil || hostname == "" {
		// "runner-" alone is a name nobody can pick out of `alethia runner list`.
		return "runner"
	}
	return fmt.Sprintf("runner-%s", hostname)
}

var runnerDeployCmd = &cobra.Command{
	Use:   "deploy",
	Short: fmt.Sprintf("Have Alethia build a runner inside your %s account", runners.DeployProvidersLabel()),
	Long: fmt.Sprintf(`Creates a runner record and queues a DEPLOY_RUNNER job, which builds the runner inside your
cloud account from the latest stable release.

Use it for a second runner, or a runner closer to what it provisions. It is not how an
organization gets its first runner: building a runner is itself a job, so a runner that is
already online (or the managed fleet) has to run it. With neither, the command refuses before
anything is created and names "alethia runner register", which needs nothing to exist.

Deployed runners are %s only. On %s use "alethia runner register" instead: it provisions
nothing, and a runner you run yourself works on every cloud. An account on another cloud is
refused here, before a runner or a job is created.

Every field is a flag, so the command runs unattended: --name and --region take their defaults
when omitted, and an omitted --assigned-runner leaves the job for any runner that is online.
Only the cloud account has no default. --dry-run checks every input and prints the request
without sending it.`, runners.DeployProvidersLabel(), runnerRegisterOnlyClouds()),
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runRunnerDeploy(cmd); err != nil {
			fail(err)
		}
	},
}

// runnerRegisterOnlyClouds names the offered clouds a runner cannot be deployed into, as one
// phrase: "GCP, Azure and Hetzner". It is the offered set minus the deployable one, so it follows
// both lists.
func runnerRegisterOnlyClouds() string {
	var out []string
	for _, provider := range EnabledCloudProviders() {
		if runners.IsDeployProvider(string(provider)) {
			continue
		}
		for _, c := range catalog.MustLoad().Live.Providers {
			if c.Slug == string(provider) {
				out = append(out, c.ShortName)
			}
		}
	}
	if len(out) == 0 {
		return "any other cloud"
	}
	return joinWithAnd(out)
}

// runnerDeployClient is what `runner deploy` asks the control plane.
type runnerDeployClient interface {
	runnerSource
	cloudIdentityLister
	jobPoller
	DeployRunner(name, cloudIdentityID, region, assignedRunnerID string) (*api.DeployRunnerResponse, error)
}

// runRunnerDeploy is `runner deploy` up to authentication.
func runRunnerDeploy(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	result, err := deployRunner(ctx, printer, api.NewClient(token), token, cmdmeta.DryRunRequested(cmd))
	if err != nil {
		return err
	}
	return printRunnerJob(cmd, result)
}

// deployRunner resolves every field of a deploy, checks that something can run the job, and
// queues it — or, on a dry run, returns the request it would have sent.
func deployRunner(ctx context.Context, p *Printer, c runnerDeployClient, token string, dryRun bool) (MutationResult, error) {
	result := MutationResult{Kind: "runner", Action: ResultQueued, DryRun: dryRun}

	identityID, err := runnerDeployIdentityID(c, deployCloudAccount, deployCloudIdentityID)
	if err != nil {
		return result, err
	}

	// Read before anything is asked: a person should not pick a name and a region for a deploy
	// that nothing can run.
	list, err := c.GetRunners()
	if err != nil {
		return result, fmt.Errorf("list runners: %w", err)
	}
	assignedID, err := runnerIDFrom(runnerList(list), deployAssignedRunner, deployAssignedID,
		"--assigned-runner", "--assigned-runner-id")
	if err != nil {
		return result, err
	}
	if err := runnerJobExecutor(c, list, "build a runner", assignedID, ""); err != nil {
		return result, err
	}

	if identityID == "" {
		if !canPromptForm() {
			// Naming the flag matters more than naming the mode: the reader of a CI log needs
			// the thing to add, not a restatement of the switch they already passed.
			return result, refusal(clierr.CodeInputRequired, "alethia connector list",
				"no cloud account given: pass --cloud-account (its label or its id), or --cloud-identity-id (%s only). "+
					"Nothing can ask for it (--no-input, stdin is not a terminal, or stderr is redirected)",
				runners.DeployProvidersLabel())
		}
		// Deliberately NOT selectCloudIdentity: that lists EVERY linked cloud, which is right
		// for `project create` and wrong here. Only a cloud with a runner template can be
		// built into.
		if identityID, err = selectRunnerDeployCloudIdentity(token); err != nil {
			return result, err
		}
	}

	if err := runnerAskOrDefault(&deployRunnerName,
		"Runner name", "How this runner appears in `alethia runner list`", deployDefaultName()); err != nil {
		return result, err
	}
	if err := runnerAskOrDefault(&deployRegion,
		"Region", "Cloud region to deploy the runner into", deployRegionDefault); err != nil {
		return result, err
	}

	// The executor picker cannot be answered with prompting disabled, and an empty id leaves the
	// job for any runner that is online. A dry run asks nothing it does not need.
	if assignedID == "" && canPromptForm() && !dryRun {
		if assignedID, err = selectRunner(token, ""); err != nil {
			return result, err
		}
	}

	obj := runnerJobObject{Name: deployRunnerName, Warnings: []string{}}
	if dryRun {
		obj.Request = &runnerJobRequest{
			JobType: runnerDeployJobType, Name: deployRunnerName,
			CloudIdentityID: identityID, Region: deployRegion, AssignedRunnerID: assignedID,
		}
		result.Object = obj
		return result, nil
	}

	resp, err := c.DeployRunner(deployRunnerName, identityID, deployRegion, assignedID)
	if err != nil {
		return result, runnerDeployError(err)
	}
	result.ID = resp.Runner.ID
	result.Job = &JobRef{ID: resp.Job.ID, Type: runnerDeployJobType}
	if resp.Runner.Name != "" {
		obj.Name = resp.Runner.Name
	}
	obj.JobStatus = resp.Job.Status
	p.Note(fmt.Sprintf("Runner %q created (id %s). It comes online when the job below finishes.", obj.Name, result.ID))

	if err := followRunnerJob(ctx, p, c, deployRunnerWait, *result.Job, &obj); err != nil {
		return result, err
	}
	result.Object = obj
	return result, nil
}

// runnerDeployError adds the next step to a deploy the control plane refused. A refusal of the
// input is most often an account on a cloud a runner cannot be built in, named by a raw id the
// CLI did not resolve; the way out is the same either way.
func runnerDeployError(err error) error {
	e := *clierr.From(err)
	if e.Hint == "" && e.Class == clierr.ClassUsage {
		e.Hint = "alethia runner register   (a runner you run yourself, on any cloud)"
	}
	return &e
}

func init() {
	runnerCmd.AddCommand(runnerDeployCmd)
	runnerDeployCmd.Flags().StringVar(&deployCloudAccount, "cloud-account", "",
		fmt.Sprintf("Cloud account to deploy into, by LABEL or id (%s only; asked for on a terminal when omitted)",
			runners.DeployProvidersLabel()))
	runnerDeployCmd.Flags().StringVar(&deployCloudIdentityID, "cloud-identity-id", "",
		"Cloud identity id to deploy into (prefer --cloud-account, which also takes the label)")
	runnerDeployCmd.Flags().StringVar(&deployRunnerName, "name", "",
		"Runner name (default: runner-<hostname>)")
	runnerDeployCmd.Flags().StringVar(&deployRegion, "region", "",
		"Cloud region (default: "+deployRegionDefault+")")
	runnerDeployCmd.Flags().StringVar(&deployAssignedRunner, "assigned-runner", "",
		"Runner that executes the deployment, by NAME or id (any that is online when omitted)")
	runnerDeployCmd.Flags().StringVar(&deployAssignedID, "assigned-runner-id", "",
		"Runner id that executes the deployment (prefer --assigned-runner, which also takes the name)")
	addProjectWaitFlags(runnerDeployCmd, &deployRunnerWait)
	addDryRunFlag(runnerDeployCmd)
}
