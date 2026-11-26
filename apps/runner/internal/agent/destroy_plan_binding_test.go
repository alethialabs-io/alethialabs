// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The destroy half of plan binding (#7455): a destroy-mode PLAN records its saved plan and digest
// as an apply plan does, a DESTROY bound to one tears down exactly that plan, and the plan's mode is
// part of the binding in both directions.

// newDestroyPlanBindAPI builds a planBindAPI whose plan job reads back as a SUCCESS destroy plan.
func newDestroyPlanBindAPI(artifact []byte) *planBindAPI {
	api := newPlanBindAPI(artifact)
	api.getJobFn = func(id string) (*Job, error) { return &Job{ID: id, Status: "SUCCESS", DestroyPlan: true}, nil }
	return api
}

// boundDestroy is a DESTROY job bound to planJobID with the given digest and approval (nil = none).
func boundDestroy(planJobID, digest, approvalID *string) *Job {
	return &Job{
		ID: "bind-destroy", JobType: string(types.JobTypeDestroy),
		ConfigSnapshot: covRunSnapshot(), PlanJobID: planJobID, PlanSHA256: digest, ApprovalID: approvalID,
	}
}

// runBoundDestroy runs executeDestroy for job against api and returns how many times the stage ran,
// the plan file the stage was handed ("" when none), the payload's PlanFile, and the error.
func runBoundDestroy(t *testing.T, api *planBindAPI, job *Job) (runs int, handed, payloadPlan string, err error) {
	t.Helper()
	sb := &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		if b, readErr := os.ReadFile(filepath.Join(spec.WorkDir, "plan-apply.out")); readErr == nil {
			handed = string(b)
		}
		var p stageDestroyPayload
		if spec.Stage != nil && json.Unmarshal(spec.Stage.Payload, &p) == nil {
			payloadPlan = p.PlanFile
		}
		return nil
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-bind"}, api)
	w.sandbox = sb
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	err = w.executeDestroy(t.Context(), job, "aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	return sb.runs(), handed, payloadPlan, err
}

// A DESTROY whose saved destroy plan hashes to the digest it carries tears down that plan.
func TestDestroyPlanBinding_MatchAppliesTheReviewedDestroyPlan(t *testing.T) {
	plan := []byte("reviewed-destroy-plan")
	planJobID, approval := "plan-d1", "approval-1"
	api := newDestroyPlanBindAPI(plan)

	runs, handed, payloadPlan, err := runBoundDestroy(t, api, boundDestroy(&planJobID, planDigestOf(plan), &approval))
	if err != nil {
		t.Fatalf("a matching digest must destroy: %v", err)
	}
	if runs != 1 || handed != string(plan) {
		t.Fatalf("the stage must run once with the reviewed plan (runs %d, handed %q)", runs, handed)
	}
	if !strings.HasSuffix(payloadPlan, "plan-apply.out") {
		t.Fatalf("the destroy stage must be told to apply the reviewed plan, payload plan_file = %q", payloadPlan)
	}
	if len(api.downloads) != 1 || api.downloads[0] != planJobID {
		t.Fatalf("the plan must be fetched once from the bound plan job, got %v", api.downloads)
	}
}

// Every way a bound DESTROY can fail to be shown to tear down its reviewed plan is a typed refusal
// that says "Destroy refused", and the stage never runs.
func TestDestroyPlanBinding_Refusals(t *testing.T) {
	plan := []byte("reviewed-destroy-plan")
	planJobID, approval := "plan-d1", "approval-1"

	for _, tc := range []struct {
		name     string
		job      *Job
		artifact []byte
		dlErr    error
		getJob   func(string) (*Job, error)
		want     PlanBindingCode
	}{
		{name: "digest differs", job: boundDestroy(&planJobID, planDigestOf(plan), &approval), artifact: []byte("another-plan"), want: PlanDigestMismatch},
		{name: "named plan without digest", job: boundDestroy(&planJobID, nil, &approval), artifact: plan, want: PlanDigestMissing},
		{name: "approved but names no plan", job: boundDestroy(nil, nil, &approval), artifact: plan, want: PlanRequired},
		{name: "artifact cannot be fetched", job: boundDestroy(&planJobID, planDigestOf(plan), &approval), dlErr: errors.New("plan artifact not found"), want: PlanArtifactUnavailable},
		{
			name: "plan is an apply plan", job: boundDestroy(&planJobID, planDigestOf(plan), &approval), artifact: plan,
			getJob: func(id string) (*Job, error) { return &Job{ID: id, Status: "SUCCESS"}, nil },
			want:   PlanModeMismatch,
		},
		{
			name: "plan did not succeed", job: boundDestroy(&planJobID, planDigestOf(plan), &approval), artifact: plan,
			getJob: func(id string) (*Job, error) { return &Job{ID: id, Status: "FAILED", DestroyPlan: true}, nil },
			want:   PlanJobNotSucceeded,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newDestroyPlanBindAPI(tc.artifact)
			api.downloadErr = tc.dlErr
			if tc.getJob != nil {
				api.getJobFn = tc.getJob
			}
			runs, handed, _, err := runBoundDestroy(t, api, tc.job)
			code, ok := planBindingRefusal(err)
			if !ok || code != tc.want {
				t.Fatalf("want refusal %q, got %v", tc.want, err)
			}
			if runs != 0 || handed != "" {
				t.Fatalf("a refused destroy must not reach the stage (runs %d, handed %q)", runs, handed)
			}
			if !strings.HasPrefix(err.Error(), "Destroy refused: ") || !strings.Contains(err.Error(), "Run a new destroy plan") {
				t.Errorf("the refusal must read as a destroy instruction, got %q", err)
			}
		})
	}
}

// A DESTROY that names no plan and consumed no approval (a person's click, the ephemeral reap) is not
// bound: nothing is fetched and the teardown runs as before.
func TestDestroyPlanBinding_UnboundDestroyRunsAsBefore(t *testing.T) {
	api := newDestroyPlanBindAPI([]byte("unused"))
	runs, handed, payloadPlan, err := runBoundDestroy(t, api, boundDestroy(nil, nil, nil))
	if err != nil || runs != 1 {
		t.Fatalf("the destroy must run (err %v, runs %d)", err, runs)
	}
	if handed != "" || payloadPlan != "" || len(api.downloads) != 0 {
		t.Fatalf("no plan may be fetched or handed (handed %q, payload %q, downloads %v)", handed, payloadPlan, api.downloads)
	}
}

// A DEPLOY never applies a destroy plan, whatever digest it carries.
func TestDestroyPlanBinding_DeployRefusesADestroyPlan(t *testing.T) {
	plan := []byte("reviewed-destroy-plan")
	planJobID := "plan-d1"
	runs, handed, err := runBoundDeploy(t, newDestroyPlanBindAPI(plan), boundJob(&planJobID, planDigestOf(plan)))
	if code, ok := planBindingRefusal(err); !ok || code != PlanModeMismatch {
		t.Fatalf("want %q, got %v", PlanModeMismatch, err)
	}
	if runs != 0 || handed != "" {
		t.Fatalf("a deploy of a destroy plan must not reach the stage (runs %d, handed %q)", runs, handed)
	}
}

// runDestroyPlanJob runs executePlan for a destroy-mode PLAN job; the sandbox answers as the stage
// does — the saved plan's bytes (nil = none) and the plan JSON in result.json — and also plants a
// decoy file at the plan path, which the parent must never read.
func runDestroyPlanJob(t *testing.T, api *covRunAPI, planBytes []byte) (sandbox.Spec, error) {
	t.Helper()
	return runDestroyPlanJobWith(t, api, api, planBytes)
}

// runDestroyPlanJobWith is runDestroyPlanJob with the runner talking to `client`, which may wrap
// `api` (the recorder the assertions read).
func runDestroyPlanJobWith(t *testing.T, client JobAPI, api *covRunAPI, planBytes []byte) (sandbox.Spec, error) {
	t.Helper()
	var seen sandbox.Spec
	sb := &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		seen = spec
		var p stageDestroyPayload
		if err := json.Unmarshal(spec.Stage.Payload, &p); err != nil {
			return err
		}
		if err := os.WriteFile(p.PlanOutFile, []byte("decoy-the-parent-must-not-read"), 0o600); err != nil {
			return err
		}
		var planJSON map[string]interface{}
		if err := json.Unmarshal([]byte(`{"resource_changes":[{"address":"aws_db_instance.main","type":"aws_db_instance","change":{"actions":["delete"],"before":{"password":"hunter2-state-secret"},"before_sensitive":{"password":true},"after":null}}]}`), &planJSON); err != nil {
			return err
		}
		pr, err := json.Marshal(provisioner.PlanResult{PlanJSON: planJSON, PlanFileBytes: planBytes})
		if err != nil {
			return err
		}
		return writeStageResult(spec.WorkDir, stageResult{PlanResult: pr}, nil)
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-dplan"}, client)
	w.sandbox = sb
	job := &Job{ID: "dplan-1", JobType: string(types.JobTypePlan), ConfigSnapshot: covRunSnapshot(), DestroyPlan: true}
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	err := w.executePlan(t.Context(), job, "aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	return seen, err
}

// uploadRecordingAPI records the bytes of each uploaded plan artifact.
type uploadRecordingAPI struct {
	*covRunAPI
	uploaded [][]byte
}

// UploadPlanArtifact reads the file being uploaded, then reports the configured outcome.
func (a *uploadRecordingAPI) UploadPlanArtifact(jobID, filePath string) error {
	b, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}
	a.uploaded = append(a.uploaded, b)
	return a.covRunAPI.UploadPlanArtifact(jobID, filePath)
}

// A destroy-mode PLAN stages a destroy plan (never a teardown), stores the saved plan as the job's
// artifact, and records that file's digest — what the DESTROY bound to it is checked against.
func TestDestroyPlanJob_RecordsArtifactAndDigest(t *testing.T) {
	rec := &uploadRecordingAPI{covRunAPI: newCovRunAPI()}
	api := rec.covRunAPI
	planBytes := []byte("saved-destroy-plan")
	spec, err := runDestroyPlanJobWith(t, rec, api, planBytes)
	if err != nil {
		t.Fatalf("executePlan(destroy): %v", err)
	}
	if spec.Stage == nil || spec.Stage.Kind != sandbox.StageDestroy {
		t.Fatalf("a destroy plan must run the destroy stage, got %+v", spec.Stage)
	}
	var p stageDestroyPayload
	if err := json.Unmarshal(spec.Stage.Payload, &p); err != nil || !p.DryRun || p.PlanFile != "" {
		t.Fatalf("the destroy stage must be told to plan only (payload %+v, err %v)", p, err)
	}
	if api.uploadCalls != 1 || len(rec.uploaded) != 1 {
		t.Fatalf("the saved plan must be uploaded once, got %d", api.uploadCalls)
	}
	// What is stored is the plan the stage handed back, never a file at a path the stage controls.
	if string(rec.uploaded[0]) != string(planBytes) {
		t.Fatalf("uploaded %q, want the stage's saved plan", rec.uploaded[0])
	}
	var meta map[string]any
	for _, u := range api.getStatusUpdates() {
		if _, ok := u.metadata["plan_file_sha256"]; ok {
			meta = u.metadata
		}
	}
	if meta == nil {
		t.Fatal("the destroy plan's digest was never posted")
	}
	if meta["plan_file_sha256"] != *planDigestOf(planBytes) {
		t.Errorf("posted digest = %v, want the saved plan's SHA-256", meta["plan_file_sha256"])
	}
	if meta["destroy_plan"] != true {
		t.Errorf("metadata must mark the plan as a destroy plan: %v", meta)
	}
	pr, ok := meta["plan_result"].(map[string]any)
	if !ok {
		t.Fatalf("metadata must carry the destroy plan's resource changes: %v", meta)
	}
	changes, ok := pr["resource_changes"].([]any)
	if !ok || len(changes) != 1 {
		t.Fatalf("want one resource change, got %v", pr["resource_changes"])
	}
	rc, _ := changes[0].(map[string]any)
	if rc["address"] != "aws_db_instance.main" || rc["type"] != "aws_db_instance" {
		t.Errorf("the change must keep the resource's identity, got %v", rc)
	}
	blob, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	// A teardown's `before` is the resource's whole current state; none of it is persisted.
	if strings.Contains(string(blob), "hunter2-state-secret") || strings.Contains(string(blob), "before") {
		t.Errorf("the destroy plan's posted result must not carry the resources' state: %s", blob)
	}
}

// A destroy plan whose saved plan cannot be stored, or was never written, fails rather than posting
// a digest nothing can be checked against.
func TestDestroyPlanJob_FailsWithoutAStoredArtifact(t *testing.T) {
	t.Run("upload refused", func(t *testing.T) {
		api := newCovRunAPI()
		api.uploadErr = errors.New("storage refused")
		if _, err := runDestroyPlanJob(t, api, []byte("saved-destroy-plan")); err == nil {
			t.Fatal("a destroy plan whose artifact was not stored must fail")
		}
		for _, u := range api.getStatusUpdates() {
			if _, ok := u.metadata["plan_file_sha256"]; ok {
				t.Fatalf("no digest may be posted for an unstored plan: %v", u.metadata)
			}
		}
	})
	t.Run("no plan file", func(t *testing.T) {
		api := newCovRunAPI()
		if _, err := runDestroyPlanJob(t, api, nil); err == nil {
			t.Fatal("a destroy plan that saved no plan file must fail")
		}
		if api.uploadCalls != 0 {
			t.Fatalf("nothing may be uploaded, got %d uploads", api.uploadCalls)
		}
	})
}
