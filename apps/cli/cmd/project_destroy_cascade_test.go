// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// #5249: a `dedicated` environment owns its cluster, and destroying it while namespace/vcluster
// environments are still placed on that cluster orphans them. The control plane refuses that destroy
// (naming the tenants) unless the caller cascades, and holds a cascaded owner's DESTROY until its
// tenants are gone. What the CLI owes on top:
//
//   - a refusal is printed with the server's list AND the flag that gets past it;
//   - --cascade shows the WHOLE tree, in order, before anything is queued — and declining queues nothing;
//   - --cascade sends `cascade: true`, and a plain destroy never does;
//   - --wait waits for every job, and a failed TENANT is reported as what it is: the owner's job is
//     not failed, it is waiting, and the message names how to unblock it.

func boutiqueTree() []map[string]any {
	return []map[string]any{
		{"environment_id": "e-dev1", "name": "dev-1", "placement_mode": "namespace", "status": "ACTIVE", "owns_fabric": false, "waiting_on": []any{}},
		{"environment_id": "e-stg", "name": "staging", "placement_mode": "vcluster", "status": "FAILED", "owns_fabric": false, "waiting_on": []any{}},
		{"environment_id": "e1", "name": "production", "placement_mode": "dedicated", "status": "ACTIVE", "owns_fabric": true,
			"waiting_on": []any{map[string]any{"name": "dev-1", "status": "ACTIVE"}, map[string]any{"name": "staging", "status": "FAILED"}}},
	}
}

func boutiqueCascadeJobs() []map[string]any {
	return []map[string]any{
		{"job_id": "j-dev1", "environment_id": "e-dev1", "name": "dev-1"},
		{"job_id": "j-stg", "environment_id": "e-stg", "name": "staging"},
		{"job_id": "j-owner", "environment_id": "e1", "name": "production"},
	}
}

// TestRenderDestroyTree_NamesEveryEnvironmentInOrder pins the line the operator confirms against.
func TestRenderDestroyTree_NamesEveryEnvironmentInOrder(t *testing.T) {
	var tree []api.DestroyTreeNode
	for _, n := range boutiqueTree() {
		tree = append(tree, api.DestroyTreeNode{
			Name: n["name"].(string), PlacementMode: n["placement_mode"].(string),
			Status: n["status"].(string), OwnsFabric: n["owns_fabric"].(bool),
		})
	}
	got := renderDestroyTree(tree)
	want := "Will destroy, in order: dev-1 (namespace), staging (vcluster, failed), production (dedicated, owns the cluster)"
	if got != want {
		t.Fatalf("renderDestroyTree:\n got %q\nwant %q", got, want)
	}

	alone := renderDestroyTree(tree[2:])
	if !strings.Contains(alone, "Nothing else is placed") || !strings.Contains(alone, "production (dedicated, owns the cluster)") {
		t.Errorf("a tree of one should say nothing else is affected, got %q", alone)
	}
}

// TestProjDestroy_RefusalPrintsTheServersListAndTheWayOut is the default path: no cascade, live
// tenants. The command fails, prints the server's tenant list, and names --cascade.
func TestProjDestroy_RefusalPrintsTheServersListAndTheWayOut(t *testing.T) {
	s := &projServer{
		envs:           projSampleEnvs(),
		destroyRefusal: `Environment "production" owns the cluster that 2 other environments are still placed on: dev-1 (namespace, ACTIVE), staging (vcluster, FAILED). Destroy them first, or cascade the destroy (CLI: --cascade).`,
	}
	h := projEnv(t, s)
	projConfirm(t, true)

	var exited bool
	// The refusal is read from stderr: the fatal path writes nothing to stdout.
	_, out := captureStreams(t, func() {
		exited = h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "production")
	})
	if !exited {
		t.Fatal("a refused destroy must exit non-zero")
	}
	for _, want := range []string{"dev-1 (namespace, ACTIVE)", "staging (vcluster, FAILED)", "re-run with --cascade"} {
		if !strings.Contains(out, want) {
			t.Errorf("refusal output is missing %q:\n%s", want, out)
		}
	}
	post, ok := s.lastPost()
	if !ok || post.Body["cascade"] != nil {
		t.Errorf("a plain destroy must not send cascade, sent %+v", post.Body)
	}
}

// TestProjDestroy_CascadePrintsTheTreeThenQueuesWithCascade pins the cascade path end to end.
func TestProjDestroy_CascadePrintsTheTreeThenQueuesWithCascade(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), destroyTree: boutiqueTree(), cascadeJobs: boutiqueCascadeJobs()}
	h := projEnv(t, s)

	var exited bool
	// The tree and the queued-job notices are said about the run, so they are read from stderr.
	_, out := captureStreams(t, func() {
		exited = h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "production", "--cascade", "--yes")
	})
	if exited {
		t.Fatalf("project destroy --cascade exited fatally:\n%s", out)
	}
	want := "Will destroy, in order: dev-1 (namespace), staging (vcluster, failed), production (dedicated, owns the cluster)"
	if !strings.Contains(out, want) {
		t.Errorf("the tree was not printed before queueing; want %q in:\n%s", want, out)
	}
	if strings.Index(out, want) > strings.Index(out, "Queued DESTROY") {
		t.Error("the tree must be printed BEFORE anything is queued")
	}
	for _, id := range []string{"j-dev1", "j-stg", "j-owner"} {
		if !strings.Contains(out, id) {
			t.Errorf("queued job %s not reported:\n%s", id, out)
		}
	}
	post, ok := s.lastPost()
	if !ok || post.Body["cascade"] != true || post.Body["environment_id"] != "e1" {
		t.Errorf("the destroy must be sent with cascade: true for the resolved env, sent %+v", post.Body)
	}
	if s.hits("/destroy-tree") != 1 {
		t.Errorf("the tree must be fetched exactly once, got %d", s.hits("/destroy-tree"))
	}
}

// TestProjDestroy_CascadeDeclinedQueuesNothing: the operator saw the tree and said no.
func TestProjDestroy_CascadeDeclinedQueuesNothing(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), destroyTree: boutiqueTree(), cascadeJobs: boutiqueCascadeJobs()}
	h := projEnv(t, s)
	projConfirm(t, false)
	if h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--cascade") {
		t.Error("a declined cascade should not exit")
	}
	if _, ok := s.lastPost(); ok {
		t.Error("a declined cascade queued something")
	}
}

// TestProjDestroy_CascadeWaitWaitsForEveryJob pins --wait over the whole tree.
func TestProjDestroy_CascadeWaitWaitsForEveryJob(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), destroyTree: boutiqueTree(), cascadeJobs: boutiqueCascadeJobs()}
	h := projEnv(t, s)
	if h.run("project", "destroy", "--project-id", "p1", "--cascade", "--wait", "--yes", "--no-input") {
		t.Error("project destroy --cascade --wait exited fatally on three successful jobs")
	}
	if n := s.hits("/api/cli/jobs/"); n < 3 {
		t.Errorf("--wait must poll every queued job, polled %d times", n)
	}
}

// fakeJobs answers GetJob from a fixed id → status map. It is a whole projectJobClient: queueing
// answers with the cascade it was given, and it belongs to no organization.
type fakeJobs struct {
	status  map[string]string
	cascade []api.CascadeJob
}

func (f fakeJobs) GetJob(id string) (*api.ProvisionJob, error) {
	st, ok := f.status[id]
	if !ok {
		return nil, errors.New("no such job")
	}
	return &api.ProvisionJob{ID: id, Status: st}, nil
}

func (f fakeJobs) QueueJobFull(api.QueueJobParams) (*api.QueueJobResponse, error) {
	return &api.QueueJobResponse{CascadeJobs: f.cascade}, nil
}

func (f fakeJobs) Whoami() (*api.WhoAmI, error) { return nil, errors.New("no organization") }

// waitCascade queues and waits on a cascade through the shared job runner, and returns its error.
func waitCascade(t *testing.T, f fakeJobs) error {
	t.Helper()
	prev := jobPollInterval
	jobPollInterval = 0
	t.Cleanup(func() { jobPollInterval = prev })
	_, err := runProjectJob(context.Background(), testPrinter(io.Discard, "table"), f, projectJobRun{
		Params: api.QueueJobParams{JobType: "DESTROY", ConfigurationID: "p1", Cascade: true},
		Wait:   waitFlags{Wait: true},
	})
	return err
}

// TestCascadeWait_AFailedTenantNamesTheWaitingOwner is the failed-tenant behaviour: the
// owner's DESTROY is held QUEUED by the control plane, so it never fails on its own — a wait that
// polled it would hang. The wait stops at the failed tenant and says how to unblock the owner.
func TestCascadeWait_AFailedTenantNamesTheWaitingOwner(t *testing.T) {
	queued := []api.CascadeJob{
		{JobID: "j-dev1", Name: "dev-1"},
		{JobID: "j-stg", Name: "staging"},
		{JobID: "j-owner", Name: "production"},
	}
	err := waitCascade(t, fakeJobs{
		status:  map[string]string{"j-dev1": "SUCCESS", "j-stg": "FAILED", "j-owner": "QUEUED"},
		cascade: queued,
	})
	if err == nil {
		t.Fatal("a failed tenant must fail the wait")
	}
	for _, want := range []string{
		"staging", "production's DESTROY (job j-owner) stays QUEUED",
		"alethia project destroy --project p1 --env staging", "alethia jobs cancel j-owner",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("failed-tenant message is missing %q: %v", want, err)
		}
	}
	// The explanation is added to the failure, not put in its place: the exit is still the one a
	// failed remote operation owns, and the job that failed is still named.
	if e := clierr.From(err); e.Exit != clierr.ExitOperationFailed || e.Operation == nil || e.Operation.ID != "j-stg" {
		t.Errorf("a failed tenant must exit %d naming job j-stg, got exit %d operation %+v",
			clierr.ExitOperationFailed, e.Exit, e.Operation)
	}

	// The owner's own failure is reported plainly — nothing is waiting behind it.
	err = waitCascade(t, fakeJobs{
		status:  map[string]string{"j-dev1": "SUCCESS", "j-stg": "SUCCESS", "j-owner": "FAILED"},
		cascade: queued,
	})
	if err == nil || strings.Contains(err.Error(), "stays QUEUED") {
		t.Errorf("an owner failure should be reported as itself, got %v", err)
	}
}

// TestCascadeWait_ATenantThatCannotBePolledIsNotCalledFailed keeps the stalled-owner explanation
// for a job that FAILED. A poll that could not be made says nothing about the job, so the error is
// the poll's own.
func TestCascadeWait_ATenantThatCannotBePolledIsNotCalledFailed(t *testing.T) {
	err := waitCascade(t, fakeJobs{
		status:  map[string]string{"j-owner": "QUEUED"},
		cascade: []api.CascadeJob{{JobID: "j-gone", Name: "dev-1"}, {JobID: "j-owner", Name: "production"}},
	})
	if err == nil || strings.Contains(err.Error(), "stays QUEUED") {
		t.Errorf("a failed poll must not be explained as a failed destroy, got %v", err)
	}
}

// TestDestroyQueueError_OnlyARefusalGetsTheHint keeps the --cascade hint off unrelated failures,
// and off a destroy that already cascaded.
func TestDestroyQueueError_OnlyARefusalGetsTheHint(t *testing.T) {
	refused := &api.APIError{StatusCode: 409, Message: "… or cascade the destroy (CLI: --cascade) …"}
	got := clierr.From(destroyQueueError(refused, false))
	if !strings.Contains(got.Hint, "re-run with --cascade") {
		t.Errorf("refusal without the hint: %+v", got)
	}
	// The hint is added to the control plane's answer; its class and its sentence are kept.
	if got.Exit != clierr.ExitConflict || !strings.Contains(got.Message, "cascade the destroy") {
		t.Errorf("the refusal must stay a conflict carrying the server's sentence, got exit %d %q", got.Exit, got.Message)
	}
	if got := clierr.From(destroyQueueError(refused, true)); got.Hint != "" {
		t.Errorf("a cascaded destroy must not be told to cascade: %q", got.Hint)
	}
	busy := &api.APIError{StatusCode: 409, Message: "Environment is not in a valid state for this operation — a job may already be in progress."}
	if got := clierr.From(destroyQueueError(busy, false)); got.Hint != "" {
		t.Errorf("a job-in-flight conflict is not a tenant refusal: %q", got.Hint)
	}
}

// fakeTree answers GetDestroyTree with a fixed tree or error.
type fakeTree struct {
	tree []api.DestroyTreeNode
	err  error
}

func (f fakeTree) GetDestroyTree(string, string) ([]api.DestroyTreeNode, error) {
	return f.tree, f.err
}

// TestDestroyTree_RefusesToConfirmAgainstNothing pins the two ways the tree can fail to
// arrive. Either way --cascade must stop BEFORE the confirmation: an operator cannot be asked to
// approve a list they were never shown.
func TestDestroyTree_RefusesToConfirmAgainstNothing(t *testing.T) {
	if _, err := destroyTree(fakeTree{err: errBoom}, "p1", "e1"); !errors.Is(err, errBoom) {
		t.Errorf("a failed tree read must surface, got %v", err)
	}
	if _, err := destroyTree(fakeTree{}, "p1", "e1"); err == nil {
		t.Error("an empty tree must be refused, not rendered as nothing to destroy")
	}
}

// TestProjDestroy_CascadeTreeFailureQueuesNothing is the same through the command.
func TestProjDestroy_CascadeTreeFailureQueuesNothing(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), failOn: []string{"/destroy-tree"}}
	h := projEnv(t, s)
	if !h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--cascade", "--yes") {
		t.Error("a cascade whose tree cannot be read must exit")
	}
	if _, ok := s.lastPost(); ok {
		t.Error("a cascade whose tree could not be read queued something")
	}
}

// TestQueuedJobEntries_Shapes pins the three response shapes.
func TestQueuedJobEntries_Shapes(t *testing.T) {
	if got := queuedJobEntries(&api.QueueJobResponse{}, "DESTROY"); len(got) != 0 {
		t.Errorf("no job → nothing to wait for, got %+v", got)
	}
	got := queuedJobEntries(&api.QueueJobResponse{Job: &api.ProvisionJob{ID: "j1", Status: "QUEUED"}}, "DESTROY")
	if len(got) != 1 || got[0].ID != "j1" || got[0].Type != "DESTROY" || got[0].Status != "QUEUED" {
		t.Errorf("a plain destroy waits on its one job, got %+v", got)
	}
	cascade := []api.CascadeJob{{JobID: "a", Name: "dev-1"}, {JobID: "b", Name: "prod"}}
	got = queuedJobEntries(&api.QueueJobResponse{Job: &api.ProvisionJob{ID: "b"}, CascadeJobs: cascade}, "DESTROY")
	if len(got) != 2 || got[0].Environment != "dev-1" || got[1].ID != "b" {
		t.Errorf("a cascade waits on every job, owner last, got %+v", got)
	}
}

// TestCascadeWait_AnUnnamedJobIsNamedByID keeps the message readable when the server sent no
// environment name.
func TestCascadeWait_AnUnnamedJobIsNamedByID(t *testing.T) {
	err := waitCascade(t, fakeJobs{
		status:  map[string]string{"a": "FAILED"},
		cascade: []api.CascadeJob{{JobID: "a"}, {JobID: "b", Name: "prod"}},
	})
	if err == nil || !strings.Contains(err.Error(), "the destroy of job a did not succeed") {
		t.Errorf("an unnamed job must be named by id, got %v", err)
	}
}

// TestRunProjectJob_AQueueThatNamesNoJobIsAnError pins the case nothing can follow: the request
// was accepted and the answer carries no job.
func TestRunProjectJob_AQueueThatNamesNoJobIsAnError(t *testing.T) {
	_, err := runProjectJob(context.Background(), testPrinter(io.Discard, "table"), fakeJobs{}, projectJobRun{
		Params: api.QueueJobParams{JobType: "DEPLOY", ConfigurationID: "p1"},
	})
	if err == nil || !strings.Contains(err.Error(), "named no job") {
		t.Errorf("a response with no job must be refused, got %v", err)
	}
}
