// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"strings"
	"testing"

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
	out, _ := captureStreams(t, func() {
		exited = h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "production")
	})
	if !exited {
		t.Fatal("a refused destroy must exit non-zero")
	}
	for _, want := range []string{"dev-1 (namespace, ACTIVE)", "staging (vcluster, FAILED)", "Re-run with --cascade"} {
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
	out, _ := captureStreams(t, func() {
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

// fakeJobs answers GetJob from a fixed id → status map.
type fakeJobs map[string]string

func (f fakeJobs) GetJob(id string) (*api.ProvisionJob, error) {
	st, ok := f[id]
	if !ok {
		return nil, errors.New("no such job")
	}
	return &api.ProvisionJob{ID: id, Status: st}, nil
}

// TestWaitForDestroyJobs_AFailedTenantNamesTheWaitingOwner is the failed-tenant behaviour: the
// owner's DESTROY is held QUEUED by the control plane, so it never fails on its own — a wait that
// polled it would hang. The wait stops at the failed tenant and says how to unblock the owner.
func TestWaitForDestroyJobs_AFailedTenantNamesTheWaitingOwner(t *testing.T) {
	prev := jobPollInterval
	jobPollInterval = 0
	t.Cleanup(func() { jobPollInterval = prev })

	queued := []api.CascadeJob{
		{JobID: "j-dev1", Name: "dev-1"},
		{JobID: "j-stg", Name: "staging"},
		{JobID: "j-owner", Name: "production"},
	}
	poller := fakeJobs{"j-dev1": "SUCCESS", "j-stg": "FAILED", "j-owner": "QUEUED"}

	var err error
	captureStreams(t, func() { err = waitForDestroyJobs(poller, "p1", queued) })
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

	// The owner's own failure is reported plainly — nothing is waiting behind it.
	poller = fakeJobs{"j-dev1": "SUCCESS", "j-stg": "SUCCESS", "j-owner": "FAILED"}
	captureStreams(t, func() { err = waitForDestroyJobs(poller, "p1", queued) })
	if err == nil || strings.Contains(err.Error(), "stays QUEUED") {
		t.Errorf("an owner failure should be reported as itself, got %v", err)
	}
}

// TestDestroyQueueError_OnlyARefusalGetsTheHint keeps the --cascade hint off unrelated failures,
// and off a destroy that already cascaded.
func TestDestroyQueueError_OnlyARefusalGetsTheHint(t *testing.T) {
	refusal := &api.APIError{StatusCode: 409, Message: "… or cascade the destroy (CLI: --cascade) …"}
	if got := destroyQueueError(refusal, false).Error(); !strings.Contains(got, "Re-run with --cascade") {
		t.Errorf("refusal without the hint: %q", got)
	}
	if got := destroyQueueError(refusal, true).Error(); strings.Contains(got, "Re-run") {
		t.Errorf("a cascaded destroy must not be told to cascade: %q", got)
	}
	busy := &api.APIError{StatusCode: 409, Message: "Environment is not in a valid state for this operation — a job may already be in progress."}
	if got := destroyQueueError(busy, false).Error(); strings.Contains(got, "Re-run") {
		t.Errorf("a job-in-flight conflict is not a tenant refusal: %q", got)
	}
}
