// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The runners family through its one writer: what each command prints for a program, which
// stream a refusal is on and what it exits with, and where a runner's token is and is not.

// runnerCP is a control plane as the runner commands see it. Every call is counted, so a test can
// say that a refusal sent nothing.
type runnerCP struct {
	fakeRunners
	identities []api.CloudIdentity
	job        *api.ProvisionJob
	deployErr  error
	queueErr   error
	removeErr  error
	// noJob makes a queue request answer with no job at all.
	noJob bool

	deployed []string
	queued   []api.QueueJobParams
	removed  []string
}

// GetCloudIdentities returns the configured cloud accounts.
func (c *runnerCP) GetCloudIdentities() ([]api.CloudIdentity, error) { return c.identities, nil }

// GetJob returns the configured job, a finished one by default.
func (c *runnerCP) GetJob(id string) (*api.ProvisionJob, error) {
	if c.job != nil {
		return c.job, nil
	}
	return &api.ProvisionJob{ID: id, Status: jobStatusSuccess}, nil
}

// DeployRunner records the deploy and answers with a new runner and its job.
func (c *runnerCP) DeployRunner(name, identityID, region, assignedID string) (*api.DeployRunnerResponse, error) {
	if c.deployErr != nil {
		return nil, c.deployErr
	}
	c.deployed = append(c.deployed, strings.Join([]string{name, identityID, region, assignedID}, "|"))
	resp := &api.DeployRunnerResponse{}
	resp.Runner.ID, resp.Runner.Name = "r-new", name
	resp.Job.ID, resp.Job.Status = "j-deploy", "QUEUED"
	return resp, nil
}

// QueueJobWithParams records the queued job.
func (c *runnerCP) QueueJobWithParams(params api.QueueJobParams) (*api.ProvisionJob, error) {
	if c.queueErr != nil {
		return nil, c.queueErr
	}
	c.queued = append(c.queued, params)
	if c.noJob {
		return nil, nil
	}
	return &api.ProvisionJob{ID: "j-destroy", JobType: params.JobType, Status: "QUEUED"}, nil
}

// RemoveRunner records the removal.
func (c *runnerCP) RemoveRunner(id string) error {
	if c.removeErr != nil {
		return c.removeErr
	}
	c.removed = append(c.removed, id)
	return nil
}

// runnerCPFixture is two runners of one's own: a deployed one that is online and a registered one
// that is offline.
func runnerCPFixture() []api.Runner {
	return []api.Runner{
		{ID: "r-eu", Name: "eu-runner", Operator: "self", Provisioning: "deployed", Status: "ONLINE"},
		{ID: "r-box", Name: "my-box-1", Operator: "self", Provisioning: "registered", Status: "OFFLINE"},
	}
}

// runnerUnattended puts the family's flag variables back to their zero values, turns prompting
// off, and points the CLI at a control plane that is not the hosted one — where the runner list
// is the whole truth about what can run a job.
func runnerUnattended(t *testing.T) {
	t.Helper()
	firstRunSelfHosted(t)
	hygCliConfirmSetNoInput(t, true)
	reset := func() {
		runnerResetGroupFlags()
		deployRunnerWait, destroyRunnerWait = waitFlags{}, waitFlags{}
		destroyRunnerYes, runnerRemoveYes = false, false
	}
	reset()
	t.Cleanup(reset)
	prev := jobPollInterval
	jobPollInterval = 0
	t.Cleanup(func() { jobPollInterval = prev })
}

// runnerMutationDoc is a MutationResult as a program reads it.
type runnerMutationDoc struct {
	ID     string  `json:"id"`
	Kind   string  `json:"kind"`
	Action string  `json:"action"`
	Job    *JobRef `json:"job"`
	DryRun bool    `json:"dry_run"`
	Object struct {
		Name      string          `json:"name"`
		JobStatus string          `json:"job_status"`
		Warnings  []string        `json:"warnings"`
		Request   json.RawMessage `json:"request"`
	} `json:"object"`
}

// decodeRunnerMutation prints result as json and reads it back.
func decodeRunnerMutation(t *testing.T, result MutationResult) (runnerMutationDoc, string) {
	t.Helper()
	var out bytes.Buffer
	if err := testPrinter(&out, ui.FormatJSON).Result(result, nil); err != nil {
		t.Fatalf("Result: %v", err)
	}
	var doc runnerMutationDoc
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("not one json document: %v\n%s", err, out.String())
	}
	return doc, out.String()
}

// ── runner deploy ─────────────────────────────────────────────────────────────────────────

func TestRunnerDeploy_JSONNamesTheRunnerAndItsJob(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()},
		identities: []api.CloudIdentity{{ID: "ci-aws", Provider: "aws", Label: "prod-account"}}}
	deployCloudAccount, deployRunnerName, deployRegion = "prod-account", "eu-runner-2", "eu-west-1"
	deployRunnerWait = waitFlags{Wait: true}

	p, out, errOut := splitPrinter(ui.FormatJSON)
	withPrinter(t, p)
	result, err := deployRunner(context.Background(), p, cp, "tok", false)
	if err != nil {
		t.Fatalf("deployRunner: %v", err)
	}
	doc, _ := decodeRunnerMutation(t, result)
	if doc.ID != "r-new" || doc.Kind != "runner" || doc.Action != "queued" || doc.DryRun {
		t.Errorf("document = %+v", doc)
	}
	if doc.Job == nil || doc.Job.ID != "j-deploy" || doc.Job.Type != "DEPLOY_RUNNER" {
		t.Errorf("job = %+v", doc.Job)
	}
	if doc.Object.Name != "eu-runner-2" || doc.Object.JobStatus != jobStatusSuccess || doc.Object.Warnings == nil {
		t.Errorf("object = %+v", doc.Object)
	}
	if len(cp.deployed) != 1 || cp.deployed[0] != "eu-runner-2|ci-aws|eu-west-1|" {
		t.Errorf("deploys = %v", cp.deployed)
	}
	// Everything said about the run is on stderr; the function itself writes nothing on stdout.
	if out.Len() != 0 {
		t.Errorf("stdout carries narration: %q", out.String())
	}
	if !strings.Contains(errOut.String(), "j-deploy") {
		t.Errorf("stderr does not name the queued job:\n%s", errOut.String())
	}
}

func TestRunnerDeploy_DryRunSendsNothing(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()},
		identities: []api.CloudIdentity{{ID: "ci-aws", Provider: "aws", Label: "prod-account"}}}
	deployCloudAccount = "prod-account"

	p, _, _ := splitPrinter(ui.FormatJSON)
	withPrinter(t, p)
	result, err := deployRunner(context.Background(), p, cp, "tok", true)
	if err != nil {
		t.Fatalf("deployRunner: %v", err)
	}
	doc, raw := decodeRunnerMutation(t, result)
	if !doc.DryRun || doc.Job != nil || doc.ID != "" {
		t.Errorf("document = %+v", doc)
	}
	for _, want := range []string{`"job_type": "DEPLOY_RUNNER"`, `"cloud_identity_id": "ci-aws"`, `"region": "eu-west-1"`} {
		if !strings.Contains(raw, want) {
			t.Errorf("the request does not carry %s:\n%s", want, raw)
		}
	}
	if len(cp.deployed) != 0 {
		t.Errorf("a dry run deployed: %v", cp.deployed)
	}
}

// TestRunnerDeploy_RefusesWhenNothingCanBuildIt is the first-runner wall: building a runner is a
// job, so with no runner online and no managed fleet the deploy is refused before anything is
// created, and the way out it names is `runner register`.
func TestRunnerDeploy_RefusesWhenNothingCanBuildIt(t *testing.T) {
	for name, list := range map[string][]api.Runner{
		"no runner at all":    nil,
		"none that is online": {{ID: "r-box", Name: "my-box-1", Status: "OFFLINE"}},
	} {
		t.Run(name, func(t *testing.T) {
			runnerUnattended(t)
			cp := &runnerCP{fakeRunners: fakeRunners{list: list},
				identities: []api.CloudIdentity{{ID: "ci-aws", Provider: "aws", Label: "prod-account"}}}
			deployCloudAccount = "prod-account"

			_, err := deployRunner(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
			e := clierr.From(err)
			if e == nil || e.Class != clierr.ClassConflict || e.Exit != clierr.ExitConflict {
				t.Fatalf("error = %v, want the conflict row", err)
			}
			if !strings.HasPrefix(e.Hint, "alethia runner register") {
				t.Errorf("hint = %q, want it to open with `alethia runner register`", e.Hint)
			}
			if !strings.Contains(e.Message, "Nothing was created") {
				t.Errorf("the refusal does not say that nothing was created: %s", e.Message)
			}
			if len(cp.deployed) != 0 {
				t.Errorf("a refused deploy was sent: %v", cp.deployed)
			}
		})
	}
}

func TestRunnerDeploy_TheManagedFleetCanBuildIt(t *testing.T) {
	identities := []api.CloudIdentity{{ID: "ci-aws", Provider: "aws", Label: "prod-account"}}

	t.Run("an enabled pool", func(t *testing.T) {
		runnerUnattended(t)
		cp := &runnerCP{fakeRunners: fakeRunners{pools: []api.FleetPool{{Provider: "aws", Enabled: true, Max: 2}}},
			identities: identities}
		deployCloudAccount = "prod-account"
		if _, err := deployRunner(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false); err != nil {
			t.Fatalf("deployRunner: %v", err)
		}
	})

	t.Run("the hosted control plane", func(t *testing.T) {
		runnerUnattended(t)
		t.Setenv("ALETHIA_WEB_ORIGIN", types.DefaultWebOrigin)
		cp := &runnerCP{identities: identities}
		deployCloudAccount = "prod-account"
		if _, err := deployRunner(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false); err != nil {
			t.Fatalf("deployRunner: %v", err)
		}
	})
}

// TestRunnerDeploy_AnotherCloudIsRefusedInOneSentence pins the refusal for every offered cloud a
// runner cannot be built in: the usage row, one sentence, and the alternative as the hint.
func TestRunnerDeploy_AnotherCloudIsRefusedInOneSentence(t *testing.T) {
	var others []string
	for _, provider := range EnabledCloudProviders() {
		if string(provider) != "aws" {
			others = append(others, string(provider))
		}
	}
	if len(others) == 0 {
		t.Fatal("no offered cloud other than aws — every assertion below is vacuous")
	}
	for _, provider := range others {
		t.Run(provider, func(t *testing.T) {
			runnerUnattended(t)
			cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()},
				identities: []api.CloudIdentity{{ID: "ci-x", Provider: provider, Label: "other-account"}}}
			deployCloudAccount = "other-account"

			_, err := deployRunner(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
			e := clierr.From(err)
			if e == nil || e.Class != clierr.ClassUsage || e.Exit != clierr.ExitUsage {
				t.Fatalf("error = %v, want the usage row", err)
			}
			if !strings.Contains(e.Message, provider) || !strings.Contains(e.Message, "AWS only") {
				t.Errorf("the refusal does not name the cloud and the rule: %s", e.Message)
			}
			if strings.Contains(e.Message, "\n") || strings.Contains(e.Message, "goroutine") {
				t.Errorf("the refusal is not one sentence: %q", e.Message)
			}
			if e.Hint != "alethia runner register" {
				t.Errorf("hint = %q", e.Hint)
			}
			if len(cp.deployed) != 0 {
				t.Errorf("a refused deploy was sent: %v", cp.deployed)
			}
		})
	}
}

func TestRunnerDeploy_AFailedJobIsTheOperationFailedRow(t *testing.T) {
	runnerUnattended(t)
	reason := "the account has no default VPC"
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()},
		identities: []api.CloudIdentity{{ID: "ci-aws", Provider: "aws", Label: "prod-account"}},
		job:        &api.ProvisionJob{ID: "j-deploy", Status: jobStatusFailed, ErrorMessage: &reason}}
	deployCloudAccount = "prod-account"
	deployRunnerWait = waitFlags{Wait: true}

	_, err := deployRunner(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
	e := clierr.From(err)
	if e == nil || e.Exit != clierr.ExitOperationFailed {
		t.Fatalf("error = %v, want exit %d", err, clierr.ExitOperationFailed)
	}
	if e.Operation == nil || e.Operation.ID != "j-deploy" || !strings.Contains(e.Hint, "j-deploy") {
		t.Errorf("the error does not name the job to read: %+v", e)
	}
}

func TestRunnerDeploy_AMissingAccountNamesTheFlag(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
	_, err := deployRunner(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
	e := clierr.From(err)
	if e == nil || e.Exit != clierr.ExitInputRequired || !strings.Contains(e.Message, "--cloud-account") {
		t.Fatalf("error = %v, want input_required naming --cloud-account", err)
	}
}

// ── runner destroy ────────────────────────────────────────────────────────────────────────

func TestRunnerDestroy_JSONNamesTheRunnerAndItsJob(t *testing.T) {
	runnerUnattended(t)
	list := append(runnerCPFixture(), api.Runner{ID: "r-us", Name: "us-runner", Status: "ONLINE"})
	cp := &runnerCP{fakeRunners: fakeRunners{list: list}}
	destroyRunner, destroyAssignedRunner, destroyRunnerYes = "eu-runner", "us-runner", true

	p, _, _ := splitPrinter(ui.FormatJSON)
	result, ok, err := destroyRunnerJob(context.Background(), p, cp, "tok", false)
	if err != nil || !ok {
		t.Fatalf("destroyRunnerJob: ok=%v err=%v", ok, err)
	}
	doc, _ := decodeRunnerMutation(t, result)
	if doc.ID != "r-eu" || doc.Kind != "runner" || doc.Action != "queued" || doc.Object.Name != "eu-runner" {
		t.Errorf("document = %+v", doc)
	}
	if doc.Job == nil || doc.Job.ID != "j-destroy" || doc.Job.Type != "DESTROY_RUNNER" {
		t.Errorf("job = %+v", doc.Job)
	}
	if len(cp.queued) != 1 || cp.queued[0].AssignedRunnerID != "r-us" ||
		cp.queued[0].ConfigSnapshot["runner_id"] != "r-eu" {
		t.Errorf("queued = %+v", cp.queued)
	}
}

func TestRunnerDestroy_WithNobodyToAskItNeedsYes(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
	destroyRunner = "eu-runner"

	_, _, err := destroyRunnerJob(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
	e := clierr.From(err)
	if e == nil || e.Code != clierr.CodeConfirmationRequired || e.Exit != clierr.ExitInputRequired {
		t.Fatalf("error = %v, want confirmation_required", err)
	}
	if len(cp.queued) != 0 {
		t.Errorf("an unconfirmed destroy queued a job: %+v", cp.queued)
	}
}

// TestRunnerDestroy_IsConfirmedByTypingTheRunnersName pins the confirmation: the person is asked
// for the NAME of the runner, including when the command line gave its id.
func TestRunnerDestroy_IsConfirmedByTypingTheRunnersName(t *testing.T) {
	for name, typed := range map[string]bool{"typed": true, "not typed": false} {
		t.Run(name, func(t *testing.T) {
			runnerUnattended(t)
			hygCliConfirmInteractive(t)
			prevOut := interactiveOutIsTTY
			interactiveOutIsTTY = func() bool { return true }
			t.Cleanup(func() { interactiveOutIsTTY = prevOut })

			list := append(runnerCPFixture(), api.Runner{ID: "r-us", Name: "us-runner", Status: "ONLINE"})
			cp := &runnerCP{fakeRunners: fakeRunners{list: list}}
			// The id form, so the name asked for cannot be an echo of the command line.
			destroyRunnerID, destroyAssignedRunner = "r-eu", "us-runner"

			asked := ""
			prev := confirmTypedName
			confirmTypedName = func(_, _, name string) bool { asked = name; return typed }
			t.Cleanup(func() { confirmTypedName = prev })

			_, ok, err := destroyRunnerJob(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
			if err != nil {
				t.Fatalf("destroyRunnerJob: %v", err)
			}
			if asked != "eu-runner" {
				t.Errorf("asked to type %q, want the runner's name", asked)
			}
			if ok != typed || (len(cp.queued) == 1) != typed {
				t.Errorf("ok=%v queued=%d, want both to follow the answer %v", ok, len(cp.queued), typed)
			}
		})
	}
}

func TestRunnerDestroy_RefusesWhenNothingCanRunTheTeardown(t *testing.T) {
	runnerUnattended(t)
	// The runner being destroyed is the only one online, and it cannot tear itself down.
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
	destroyRunner, destroyRunnerYes = "eu-runner", true

	_, _, err := destroyRunnerJob(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
	e := clierr.From(err)
	if e == nil || e.Exit != clierr.ExitConflict {
		t.Fatalf("error = %v, want the conflict row", err)
	}
	for _, want := range []string{"No job was queued", "alethia runner register", "alethia runner remove"} {
		if !strings.Contains(e.Message, want) {
			t.Errorf("the refusal does not say %q: %s", want, e.Message)
		}
	}
	if len(cp.queued) != 0 {
		t.Errorf("a refused destroy queued a job: %+v", cp.queued)
	}
}

func TestRunnerDestroy_AnOfflineExecutorIsRefused(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
	destroyRunner, destroyAssignedRunner, destroyRunnerYes = "eu-runner", "my-box-1", true

	_, _, err := destroyRunnerJob(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
	if e := clierr.From(err); e == nil || e.Exit != clierr.ExitConflict || !strings.Contains(e.Message, "OFFLINE") {
		t.Fatalf("error = %v, want a conflict naming the status", err)
	}
}

func TestRunnerDestroy_DryRunAsksAndSendsNothing(t *testing.T) {
	runnerUnattended(t)
	list := append(runnerCPFixture(), api.Runner{ID: "r-us", Name: "us-runner", Status: "ONLINE"})
	cp := &runnerCP{fakeRunners: fakeRunners{list: list}}
	destroyRunner = "eu-runner"

	result, ok, err := destroyRunnerJob(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", true)
	if err != nil || !ok {
		t.Fatalf("a dry run needs no --yes: ok=%v err=%v", ok, err)
	}
	doc, raw := decodeRunnerMutation(t, result)
	if !doc.DryRun || doc.Job != nil || !strings.Contains(raw, `"runner_id": "r-eu"`) {
		t.Errorf("document = %s", raw)
	}
	if len(cp.queued) != 0 {
		t.Errorf("a dry run queued a job: %+v", cp.queued)
	}
}

// ── runner remove ─────────────────────────────────────────────────────────────────────────

func TestRunnerRemove_JSONSaysWhatWasDeleted(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
	runnerRemoveRef, runnerRemoveYes = "my-box-1", true
	p, _, errOut := splitPrinter(ui.FormatJSON)
	withPrinter(t, p)

	result, ok, err := removeRunner(cp, "tok", "", false)
	if err != nil || !ok {
		t.Fatalf("removeRunner: ok=%v err=%v", ok, err)
	}
	doc, raw := decodeRunnerMutation(t, result)
	if doc.ID != "r-box" || doc.Kind != "runner" || doc.Action != "deleted" || doc.Job != nil || doc.Object.Name != "my-box-1" {
		t.Errorf("document = %s", raw)
	}
	if len(cp.removed) != 1 || cp.removed[0] != "r-box" {
		t.Errorf("removed = %v", cp.removed)
	}
	if errOut.Len() != 0 {
		t.Errorf("a registered runner needs no warning:\n%s", errOut.String())
	}
}

// TestRunnerRemove_WarnsThatADeployedRunnerKeepsRunning pins the warning on stderr: with --yes
// there is no dialog to carry it.
func TestRunnerRemove_WarnsThatADeployedRunnerKeepsRunning(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
	runnerRemoveRef, runnerRemoveYes = "eu-runner", true
	p, out, errOut := splitPrinter(ui.FormatTable)
	withPrinter(t, p)

	if _, ok, err := removeRunner(cp, "tok", "", false); err != nil || !ok {
		t.Fatalf("removeRunner: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(errOut.String(), "alethia runner destroy --runner eu-runner") {
		t.Errorf("stderr does not name the command that tears it down:\n%s", errOut.String())
	}
	if out.Len() != 0 {
		t.Errorf("the warning is on stdout: %q", out.String())
	}
}

func TestRunnerRemove_RefusalsAreTyped(t *testing.T) {
	t.Run("nobody to ask and no --yes", func(t *testing.T) {
		runnerUnattended(t)
		cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
		runnerRemoveRef = "my-box-1"
		_, _, err := removeRunner(cp, "tok", "", false)
		if e := clierr.From(err); e == nil || e.Code != clierr.CodeConfirmationRequired {
			t.Fatalf("error = %v, want confirmation_required", err)
		}
		if len(cp.removed) != 0 {
			t.Errorf("an unconfirmed remove ran: %v", cp.removed)
		}
	})
	t.Run("no runner named", func(t *testing.T) {
		runnerUnattended(t)
		_, _, err := removeRunner(&runnerCP{}, "tok", "", false)
		if e := clierr.From(err); e == nil || e.Exit != clierr.ExitInputRequired || !strings.Contains(e.Message, "--runner") {
			t.Fatalf("error = %v, want input_required naming --runner", err)
		}
	})
	t.Run("a runner the control plane no longer has", func(t *testing.T) {
		runnerUnattended(t)
		cp := &runnerCP{removeErr: &api.APIError{StatusCode: http.StatusNotFound, Message: "runner not found"}}
		runnerRemoveYes = true
		_, _, err := removeRunner(cp, "tok", "r-gone", false)
		if e := clierr.From(err); e == nil || e.Exit != clierr.ExitNotFound || e.Hint != "alethia runner list" {
			t.Fatalf("error = %+v, want not_found with the list as the hint", clierr.From(err))
		}
	})
	t.Run("a dry run removes nothing", func(t *testing.T) {
		runnerUnattended(t)
		cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()}}
		runnerRemoveRef = "my-box-1"
		result, ok, err := removeRunner(cp, "tok", "", true)
		if err != nil || !ok || !result.DryRun || len(cp.removed) != 0 {
			t.Fatalf("dry run: result=%+v ok=%v err=%v removed=%v", result, ok, err, cp.removed)
		}
	})
}

// ── runner list ───────────────────────────────────────────────────────────────────────────

func TestRunnerList_JSONIsAnArrayEvenWhenEmpty(t *testing.T) {
	var out bytes.Buffer
	if err := renderRunners(&out, ui.FormatJSON, nil); err != nil {
		t.Fatalf("renderRunners: %v", err)
	}
	if strings.TrimSpace(out.String()) != "[]" {
		t.Errorf("an empty list is %q, want []", out.String())
	}

	out.Reset()
	if err := renderRunners(&out, ui.FormatJSON, runnerCPFixture()); err != nil {
		t.Fatalf("renderRunners: %v", err)
	}
	var list []map[string]any
	if err := json.Unmarshal(out.Bytes(), &list); err != nil || len(list) != 2 {
		t.Fatalf("not an array of two records: %v\n%s", err, out.String())
	}
	for _, key := range []string{"id", "name", "operator", "provisioning", "status", "is_default"} {
		if _, ok := list[0][key]; !ok {
			t.Errorf("a runner record has no %q key: %v", key, list[0])
		}
	}
}

// TestRunnerList_TheEmptyStateSendsTheReaderToRegister pins the sentence a person with no runner
// reads: the command that works for them is `runner register`, and `runner deploy` is named only
// with its precondition.
func TestRunnerList_TheEmptyStateSendsTheReaderToRegister(t *testing.T) {
	firstRunSelfHosted(t)
	var out bytes.Buffer
	if err := renderRunners(&out, ui.FormatTable, nil); err != nil {
		t.Fatalf("renderRunners: %v", err)
	}
	said := out.String()
	register, deploy := strings.Index(said, "alethia runner register"), strings.Index(said, "alethia runner deploy")
	if register < 0 {
		t.Fatalf("the empty state does not name `alethia runner register`:\n%s", said)
	}
	if deploy >= 0 && deploy < register {
		t.Errorf("`runner deploy` is offered before `runner register`:\n%s", said)
	}
	if deploy >= 0 && !strings.Contains(said, "once a runner is online") {
		t.Errorf("`runner deploy` is named without what it needs:\n%s", said)
	}

	t.Setenv("ALETHIA_WEB_ORIGIN", types.DefaultWebOrigin)
	if hosted := runnersEmptyState(); !strings.Contains(hosted, "managed fleet") {
		t.Errorf("the hosted empty state does not say the managed fleet runs the jobs: %s", hosted)
	}
}

// ── fleet ─────────────────────────────────────────────────────────────────────────────────

func TestFleetList_JSONIsAnArrayEvenWhenEmpty(t *testing.T) {
	var out bytes.Buffer
	if err := runFleetList(&fakeClient{}, &out, ui.FormatJSON); err != nil {
		t.Fatalf("runFleetList: %v", err)
	}
	var pools []map[string]any
	if err := json.Unmarshal(out.Bytes(), &pools); err != nil || pools == nil {
		t.Fatalf("not an array: %v\n%s", err, out.String())
	}
}

func TestFleetSet_JSONIsAMutationResultCarryingThePool(t *testing.T) {
	result, err := runFleetSet(&fakeClient{updatedPool: &api.FleetPool{Provider: "aws", WarmMin: 2, Max: 6, Enabled: true}},
		"aws", api.FleetPoolUpdate{})
	if err != nil {
		t.Fatalf("runFleetSet: %v", err)
	}
	var out bytes.Buffer
	if err := printFleetSet(testPrinter(&out, ui.FormatJSON), result); err != nil {
		t.Fatalf("printFleetSet: %v", err)
	}
	var doc struct {
		ID     string `json:"id"`
		Kind   string `json:"kind"`
		Action string `json:"action"`
		Job    any    `json:"job"`
		Object struct {
			Provider string `json:"provider"`
			Max      int    `json:"max"`
		} `json:"object"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("not json: %v\n%s", err, out.String())
	}
	if doc.ID != "aws" || doc.Kind != "fleet_pool" || doc.Action != "updated" || doc.Job != nil ||
		doc.Object.Provider != "aws" || doc.Object.Max != 6 {
		t.Errorf("document = %s", out.String())
	}
}

func TestFleetError_ARefusalPointsAtYourOwnRunners(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusNotFound} {
		err := fleetError(&api.APIError{StatusCode: status, Message: "The managed fleet is not available on this deployment."})
		e := clierr.From(err)
		if e.HTTPStatus != status || !strings.HasPrefix(e.Hint, "alethia runner list") {
			t.Errorf("status %d: %+v", status, e)
		}
	}
	plain := errors.New("boom")
	if e := clierr.From(fleetError(plain)); e.Hint != "" || !errors.Is(e, plain) {
		t.Errorf("an unclassified failure gained a hint or lost its cause: %+v", e)
	}
}

// ── through the real command tree: the stream and the exit code of a refusal ──────────────

// TestRunnerRefusal_IsOnStderrWithItsExitCode drives one refusal per command through the cobra
// tree and reads both streams: stdout stays empty, stderr says what to do, and the exit code is
// the row of the table.
func TestRunnerRefusal_IsOnStderrWithItsExitCode(t *testing.T) {
	cases := []struct {
		name  string
		args  []string
		exit  int
		wants string
	}{
		{"deploy: an unknown cloud account", []string{"runner", "deploy", "--cloud-account", "nope", "--no-input"},
			clierr.ExitNotFound, "alethia connector list"},
		{"destroy: no --yes", []string{"runner", "destroy", "--runner", "eu-runner", "--no-input"},
			clierr.ExitInputRequired, "--yes"},
		{"remove: no --yes", []string{"runner", "remove", "--runner", "eu-runner", "--no-input"},
			clierr.ExitInputRequired, "--yes"},
		{"remove: an unknown runner", []string{"runner", "remove", "--runner", "nope", "--no-input", "--yes"},
			clierr.ExitNotFound, "alethia runner list"},
		{"register: no name", []string{"runner", "register", "--no-input"},
			clierr.ExitInputRequired, "--name"},
		{"fleet set: nothing to set", []string{"fleet", "set", "aws", "--no-input"},
			clierr.ExitUsage, "--warm-min"},
		{"fleet set: no provider", []string{"fleet", "set", "--max", "3", "--no-input"},
			clierr.ExitInputRequired, "aws"},
	}
	s, run := runnerEnv(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s.forget()
			var code int
			stdout, stderr := captureStreams(t, func() { code = run(tc.args...) })
			if code != tc.exit {
				t.Errorf("exit code = %d, want %d\n%s", code, tc.exit, stderr)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote on stdout: %q", stdout)
			}
			if !strings.Contains(stderr, tc.wants) {
				t.Errorf("stderr does not carry %q:\n%s", tc.wants, stderr)
			}
			for _, sent := range s.seen() {
				if !strings.HasPrefix(sent, http.MethodGet+" ") {
					t.Errorf("a refused command sent %s", sent)
				}
			}
		})
	}
}

// TestRunnerRefusal_UnderJSONIsOneErrorObject pins the machine form of a refusal.
func TestRunnerRefusal_UnderJSONIsOneErrorObject(t *testing.T) {
	_, run := runnerEnv(t)
	var code int
	stdout, stderr := captureStreams(t, func() {
		code = run("runner", "remove", "--runner", "nope", "--no-input", "--yes", "--output", "json")
	})
	if code != clierr.ExitNotFound || stdout != "" {
		t.Fatalf("exit code = %d, stdout = %q", code, stdout)
	}
	var doc struct {
		Schema string `json:"schema"`
		Error  struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &doc); err != nil {
		t.Fatalf("the last stderr line is not json: %v\n%s", err, stderr)
	}
	if doc.Schema != "alethia.error/v1" || doc.Error.Code != clierr.CodeNotFound || doc.Error.Hint != "alethia runner list" {
		t.Errorf("error document = %+v", doc)
	}
}

// ── the registration token ────────────────────────────────────────────────────────────────

// runnerEnvTokenValue is the token runnerEnv's control plane hands out.
const runnerEnvTokenValue = "tok-xyz"

// TestRunnerRegister_TheTokenIsWrittenInOnePlace drives the real command with the request log
// on, in each format, and counts the token: once on stdout, never on stderr.
func TestRunnerRegister_TheTokenIsWrittenInOnePlace(t *testing.T) {
	for _, format := range []string{ui.FormatTable, ui.FormatJSON, ui.FormatCSV} {
		t.Run(format, func(t *testing.T) {
			_, run := runnerEnv(t)
			t.Setenv(api.DebugEnv, "api")
			modeEnv(t, map[string]string{api.DebugEnv: "api"})
			var code int
			stdout, stderr := captureStreams(t, func() {
				code = run("runner", "register", "box-1", "--cloud-account", "prod-account",
					"--no-input", "--output", format)
			})
			if code != 0 {
				t.Fatalf("exit code = %d\n%s", code, stderr)
			}
			if n := strings.Count(stdout, runnerEnvTokenValue); n != 1 {
				t.Errorf("the token is on stdout %d times, want 1:\n%s", n, stdout)
			}
			if strings.Contains(stderr, runnerEnvTokenValue) {
				t.Errorf("the token is on stderr:\n%s", stderr)
			}
			// The request log must have been on, or "not on stderr" proves nothing about it.
			if !strings.Contains(stderr, "/api/cli/runners/register") {
				t.Fatalf("the request log did not run, so this test did not read it:\n%s", stderr)
			}
			if format == ui.FormatTable {
				want := "ALETHIA_RUNNER_ID=r-reg\nALETHIA_RUNNER_TOKEN=" + runnerEnvTokenValue + "\n"
				if stdout != want {
					t.Errorf("stdout = %q, want exactly %q", stdout, want)
				}
			}
		})
	}
}

// TestRunnerRegister_ARefusedRegistrationPrintsNoCredential pins the failure path: nothing on
// stdout, and the error is the control plane's own class.
func TestRunnerRegister_ARefusedRegistrationPrintsNoCredential(t *testing.T) {
	p, out, _ := splitPrinter(ui.FormatTable)
	err := runRunnerRegister(&fakeClient{err: &api.APIError{StatusCode: http.StatusForbidden, Message: "not allowed"}},
		p, "box-1", "")
	if e := clierr.From(err); e == nil || e.Exit != clierr.ExitForbidden {
		t.Fatalf("error = %v, want the forbidden row", err)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q", out.String())
	}
}

// ── help ──────────────────────────────────────────────────────────────────────────────────

// TestRunnerHelp_SaysWhichCommandAddsTheFirstRunner pins the sentence the group's help exists
// for: `runner register` is the first step, and `runner deploy` says what it needs.
func TestRunnerHelp_SaysWhichCommandAddsTheFirstRunner(t *testing.T) {
	if !strings.Contains(runnerCmd.Long, "first runner") || !strings.Contains(runnerCmd.Long, "alethia runner register") {
		t.Errorf("`alethia runner` help does not say how the first runner is added:\n%s", runnerCmd.Long)
	}
	for _, want := range []string{"building a runner is itself a job", "alethia runner register"} {
		if !strings.Contains(runnerDeployCmd.Long, want) {
			t.Errorf("`alethia runner deploy` help does not say %q:\n%s", want, runnerDeployCmd.Long)
		}
	}
	// The clouds a runner cannot be deployed into are named from the catalog, not typed.
	for _, provider := range EnabledCloudProviders() {
		if provider == "aws" {
			continue
		}
		if !strings.Contains(strings.ToLower(runnerRegisterOnlyClouds()), string(provider)) {
			t.Errorf("%q is offered and is not named as a register-only cloud: %s", provider, runnerRegisterOnlyClouds())
		}
	}
	for _, c := range []string{"list", "deploy", "register", "destroy", "remove"} {
		sub, _, err := runnerCmd.Find([]string{c})
		if err != nil || sub.Short == "" || sub.Long == "" {
			t.Errorf("`alethia runner %s` has no Short or no Long", c)
		}
	}
}

// ── a dry run through the real command tree ───────────────────────────────────────────────

// TestRunnerDryRun_SaysWhatItWouldDoAndSendsNothing drives --dry-run on each command that takes
// it: one sentence on stdout that says nothing was sent, exit 0, and no request but reads.
func TestRunnerDryRun_SaysWhatItWouldDoAndSendsNothing(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"deploy", []string{"runner", "deploy", "--cloud-account", "prod-account", "--name", "eu-runner-2"}},
		{"register", []string{"runner", "register", "box-1"}},
		{"destroy", []string{"runner", "destroy", "--runner", "eu-runner"}},
		{"remove", []string{"runner", "remove", "--runner", "eu-runner"}},
		// An id no listed runner has is passed through, and named by that id.
		{"remove by an unlisted id", []string{"runner", "remove", "r-unlisted"}},
	}
	s, run := runnerEnv(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s.forget()
			var code int
			stdout, stderr := captureStreams(t, func() {
				code = run(append(append([]string{}, tc.args...), "--dry-run", "--no-input")...)
			})
			if code != 0 {
				t.Fatalf("exit code = %d\n%s", code, stderr)
			}
			if !strings.Contains(stdout, "Would ") || !strings.Contains(stdout, "Nothing was sent") {
				t.Errorf("stdout does not say what would happen and that nothing was sent: %q", stdout)
			}
			for _, sent := range s.seen() {
				if !strings.HasPrefix(sent, http.MethodGet+" ") {
					t.Errorf("a dry run sent %s", sent)
				}
			}
		})
	}
}

// ── the edges of the error paths ──────────────────────────────────────────────────────────

func TestRunnerDeploy_AControlPlaneRefusalOfTheInputNamesRegister(t *testing.T) {
	runnerUnattended(t)
	cp := &runnerCP{fakeRunners: fakeRunners{list: runnerCPFixture()},
		deployErr: &api.APIError{StatusCode: http.StatusBadRequest, Message: "Deploying a runner into gcp is not supported"}}
	// The raw id form is not resolved in the CLI, so the control plane is what refuses it.
	deployCloudIdentityID = "ci-gcp"

	_, err := deployRunner(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
	e := clierr.From(err)
	if e == nil || e.Exit != clierr.ExitUsage || !strings.HasPrefix(e.Hint, "alethia runner register") {
		t.Fatalf("error = %+v, want the usage row with `runner register` as the hint", e)
	}
}

func TestRunnerDestroy_AQueueThatNamesNoJobIsAnError(t *testing.T) {
	runnerUnattended(t)
	list := append(runnerCPFixture(), api.Runner{ID: "r-us", Name: "us-runner", Status: "ONLINE"})
	destroyRunner, destroyRunnerYes = "eu-runner", true

	for name, cp := range map[string]*runnerCP{
		"no job":  {fakeRunners: fakeRunners{list: list}, noJob: true},
		"refused": {fakeRunners: fakeRunners{list: list}, queueErr: errBoom},
	} {
		t.Run(name, func(t *testing.T) {
			_, ok, err := destroyRunnerJob(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatTable), cp, "tok", false)
			if err == nil || ok {
				t.Fatalf("ok=%v err=%v, want an error and nothing to print", ok, err)
			}
		})
	}
}

func TestFleetError_KeepsAHintTheControlPlaneSent(t *testing.T) {
	err := fleetError(&api.APIError{StatusCode: http.StatusForbidden, Message: "no", Hint: "ask an owner"})
	if e := clierr.From(err); e.Hint != "ask an owner" {
		t.Errorf("hint = %q, want the control plane's own", e.Hint)
	}
}

// failingWriter refuses every write.
type failingWriter struct{}

// Write always fails.
func (failingWriter) Write([]byte) (int, error) { return 0, errBoom }

// TestRunnerRegister_AFailedWriteIsReported pins that a credential that could not be written is
// an error and not a silent success: the token exists and was never shown.
func TestRunnerRegister_AFailedWriteIsReported(t *testing.T) {
	p := &Printer{Out: failingWriter{}, Err: &bytes.Buffer{}, Format: ui.FormatJSON}
	if err := runRunnerRegister(&fakeClient{}, p, "box-1", ""); err == nil {
		t.Fatal("a registration whose credential could not be written reported success")
	}
}
