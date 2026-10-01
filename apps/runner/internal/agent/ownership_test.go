// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

// #5162: a refused status/metadata post used to be discarded. Stale-job recovery requeued a DEPLOY
// mid-apply, every later post was refused ("not owned by this runner"), the runner dropped the
// refusal of the post carrying the evidence receipt, logged "job completed successfully", and
// claimed the same job again. These tests pin the runner half of the fix: a refusal is surfaced as
// ErrJobNotOwned, stops the job, is never read as success, and the apply's start is reported to the
// console so recovery can refuse to requeue it.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ownAPI is a covRunAPI whose UpdateJobStatus answer is decided per call by statusFn. Every call is
// still recorded (attempted posts are what the assertions read).
type ownAPI struct {
	*covRunAPI
	statusFn func(status string, metadata map[string]any) error
}

// UpdateJobStatus records the attempted post and returns statusFn's verdict.
func (a *ownAPI) UpdateJobStatus(jobID, status, errMsg string, metadata map[string]any) error {
	_ = a.mockAPI.UpdateJobStatus(jobID, status, errMsg, metadata)
	if a.statusFn != nil {
		return a.statusFn(status, metadata)
	}
	return nil
}

// ctxSandbox is a sandbox whose stage hook sees the stage context, so a test can observe the
// runner cancelling it.
type ctxSandbox struct {
	run func(ctx context.Context, spec sandbox.Spec) error
}

// Run hands the stage context and spec to the test's hook.
func (s *ctxSandbox) Run(ctx context.Context, spec sandbox.Spec, _ sandbox.Job) error {
	return s.run(ctx, spec)
}

// ownShortTimings shortens the watcher's poll and the metadata retry waits for one test.
func ownShortTimings(t *testing.T) {
	t.Helper()
	poll, delays := applyPhasePollInterval, metadataPostRetryDelays
	t.Cleanup(func() { applyPhasePollInterval, metadataPostRetryDelays = poll, delays })
	applyPhasePollInterval = time.Millisecond
	metadataPostRetryDelays = []time.Duration{time.Millisecond, time.Millisecond}
}

// writePhase writes the deploy phase marker exactly where RunDeployV2 would.
func ownWritePhase(t *testing.T, workDir, phase string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(workDir, "phase"), []byte(phase), 0o600); err != nil {
		t.Fatalf("write phase: %v", err)
	}
}

// statusesOf lists the statuses posted for a job, in order.
func statusesOf(api *ownAPI, jobID string) []string {
	var out []string
	for _, u := range api.getStatusUpdates() {
		if u.jobID == jobID {
			out = append(out, u.status)
		}
	}
	return out
}

// sawApplyStarted reports whether an apply_started_at marker was posted.
func sawApplyStarted(api *ownAPI) bool {
	for _, u := range api.getStatusUpdates() {
		if _, ok := u.metadata["apply_started_at"]; ok {
			return true
		}
	}
	return false
}

// TestUpdateJobStatus_ConflictIsErrJobNotOwned pins the wire contract: the console answers 409 when
// update_job_status refuses the post for ownership, and the client turns exactly that into
// ErrJobNotOwned — while a 500 stays an ordinary (retryable) error.
func TestUpdateJobStatus_ConflictIsErrJobNotOwned(t *testing.T) {
	for _, tc := range []struct {
		code     int
		notOwned bool
	}{{http.StatusConflict, true}, {http.StatusInternalServerError, false}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.code)
		}))
		err := NewRunnerAPIClient(srv.URL, "r1", "t1").UpdateJobStatus("j1", "PROCESSING", "", nil)
		srv.Close()
		if err == nil {
			t.Fatalf("status %d: expected an error", tc.code)
		}
		if got := errors.Is(err, ErrJobNotOwned); got != tc.notOwned {
			t.Errorf("status %d: errors.Is(err, ErrJobNotOwned) = %v, want %v (err: %v)", tc.code, got, tc.notOwned, err)
		}
	}
}

// TestRun_ExecuteJob_RefusedClaimNeverRunsTheStage proves a job whose very first PROCESSING post is
// refused for ownership is not run at all — it already belongs to another claim.
func TestRun_ExecuteJob_RefusedClaimNeverRunsTheStage(t *testing.T) {
	api := &ownAPI{covRunAPI: newCovRunAPI(), statusFn: func(string, map[string]any) error {
		return ErrJobNotOwned
	}}
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-own"}, api)
	w.sandbox = sb

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "own-refused", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
	})
	if !errors.Is(err, ErrJobNotOwned) {
		t.Fatalf("expected ErrJobNotOwned, got %v", err)
	}
	if sb.runs() != 0 {
		t.Errorf("the stage must not run for a job this runner does not own (ran %d times)", sb.runs())
	}
	if got := statusesOf(api, "own-refused"); len(got) != 1 {
		t.Errorf("only the refused claim post should have been attempted, got %v", got)
	}
}

// TestRun_ExecuteJob_RequeuedMidApplyIsNotReportedAsSuccess is the #5162 shape: the apply ran, then
// the console refused the post carrying the receipt because the job was requeued. The runner must
// return the ownership loss and must not post (or log) SUCCESS over it.
func TestRun_ExecuteJob_RequeuedMidApplyIsNotReportedAsSuccess(t *testing.T) {
	ownShortTimings(t)
	var requeued sync.Once
	var lost bool
	var mu sync.Mutex
	api := &ownAPI{covRunAPI: newCovRunAPI()}
	api.statusFn = func(_ string, md map[string]any) error {
		mu.Lock()
		defer mu.Unlock()
		if lost {
			return ErrJobNotOwned
		}
		if _, ok := md["verify_receipt"]; ok {
			// Recovery requeued the job while the apply ran: from here on every post is refused.
			requeued.Do(func() { lost = true })
			return ErrJobNotOwned
		}
		return nil
	}
	sb := &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		ownWritePhase(t, spec.WorkDir, "applied")
		covRunWriteResult(t, spec.WorkDir, `{"ClusterName":"c","VerifyReceipt":{}}`)
		return nil
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-own"}, api)
	w.sandbox = sb

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "own-midapply", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
	})
	if !errors.Is(err, ErrJobNotOwned) {
		t.Fatalf("a refused receipt post must surface as ErrJobNotOwned, got %v", err)
	}
	for _, s := range statusesOf(api, "own-midapply") {
		if s == "SUCCESS" {
			t.Fatalf("a job whose receipt post was refused must never be reported SUCCESS; posts: %v", statusesOf(api, "own-midapply"))
		}
	}
}

// TestRun_ExecuteDeploy_ReportsApplyStart proves the console is told the apply started, before the
// apply finishes — the marker recover_stale_jobs keys its refuse-to-requeue decision on.
func TestRun_ExecuteDeploy_ReportsApplyStart(t *testing.T) {
	ownShortTimings(t)
	api := &ownAPI{covRunAPI: newCovRunAPI()}
	sb := &ctxSandbox{run: func(ctx context.Context, spec sandbox.Spec) error {
		ownWritePhase(t, spec.WorkDir, "apply")
		deadline := time.After(5 * time.Second)
		for !sawApplyStarted(api) {
			select {
			case <-deadline:
				return errors.New("the apply start was never reported while the apply ran")
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Millisecond):
			}
		}
		covRunWriteResult(t, spec.WorkDir, `{"ClusterName":"c"}`)
		return nil
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-own"}, api)
	w.sandbox = sb

	if err := w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "own-start", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
	}); err != nil {
		t.Fatalf("deploy must succeed: %v", err)
	}
	if got := statusesOf(api, "own-start"); got[len(got)-1] != "SUCCESS" {
		t.Errorf("expected a SUCCESS terminal post, got %v", got)
	}
}

// TestRun_ExecuteDeploy_StopsAnApplyItNoLongerOwns proves a job requeued BEFORE its apply started is
// not applied by the stale runner: the apply-start post is refused, the stage context is cancelled,
// and the deploy returns the ownership loss rather than running on unowned.
func TestRun_ExecuteDeploy_StopsAnApplyItNoLongerOwns(t *testing.T) {
	ownShortTimings(t)
	api := &ownAPI{covRunAPI: newCovRunAPI()}
	api.statusFn = func(_ string, md map[string]any) error {
		if _, ok := md["apply_started_at"]; ok {
			return ErrJobNotOwned
		}
		return nil
	}
	stageCancelled := false
	sb := &ctxSandbox{run: func(ctx context.Context, spec sandbox.Spec) error {
		ownWritePhase(t, spec.WorkDir, "apply")
		select {
		case <-ctx.Done():
			stageCancelled = true
			return ctx.Err()
		case <-time.After(5 * time.Second):
			return nil // the apply ran to completion unowned — the failure this test exists for
		}
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-own"}, api)
	w.sandbox = sb

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "own-stop", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
	})
	if !stageCancelled {
		t.Fatal("the stage must be cancelled once the console refuses the apply-start post")
	}
	if !errors.Is(err, ErrJobNotOwned) {
		t.Fatalf("expected ErrJobNotOwned, got %v", err)
	}
	for _, s := range statusesOf(api, "own-stop") {
		if s == "SUCCESS" || s == "FAILED" {
			t.Errorf("no terminal status may be posted for a job this runner lost; posts: %v", statusesOf(api, "own-stop"))
		}
	}
}

// TestRun_ExecuteDeploy_MetadataPost covers the transient half: a metadata post that fails
// transiently is retried (and the deploy succeeds once it lands), and one that never lands fails
// the deploy instead of reporting SUCCESS without its receipt.
func TestRun_ExecuteDeploy_MetadataPost(t *testing.T) {
	for _, tc := range []struct {
		name     string
		failures int
		wantErr  bool
	}{{"retried until it lands", 2, false}, {"never lands", 100, true}} {
		t.Run(tc.name, func(t *testing.T) {
			ownShortTimings(t)
			var mu sync.Mutex
			remaining := tc.failures
			api := &ownAPI{covRunAPI: newCovRunAPI()}
			api.statusFn = func(_ string, md map[string]any) error {
				mu.Lock()
				defer mu.Unlock()
				if _, ok := md["cluster_name"]; ok && remaining > 0 {
					remaining--
					return errors.New("update status returned status 502")
				}
				return nil
			}
			w := NewWithAPI(Config{Operator: "self", RunnerID: "r-own"}, api)
			w.sandbox = &covRunSandbox{onRun: func(spec sandbox.Spec) error {
				covRunWriteResult(t, spec.WorkDir, `{"ClusterName":"c","VerifyReceipt":{}}`)
				return nil
			}}
			stdout := NewJobLogger(api, "own-meta", "STDOUT")
			stderr := NewJobLogger(api, "own-meta", "STDERR")
			err := w.executeDeploy(t.Context(), &Job{ID: "own-meta", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunSnapshot()},
				"hetzner", nil, nil, stdout, stderr)
			stdout.Close()
			stderr.Close()
			if (err != nil) != tc.wantErr {
				t.Fatalf("wantErr=%v, got %v", tc.wantErr, err)
			}
		})
	}
}

// TestRun_ExecuteJob_RefusedSuccessIsNotCompletion proves a refused SUCCESS post is returned as an
// error: "job completed successfully" was logged over exactly this refusal in #5162.
func TestRun_ExecuteJob_RefusedSuccessIsNotCompletion(t *testing.T) {
	api := &ownAPI{covRunAPI: newCovRunAPI(), statusFn: func(status string, _ map[string]any) error {
		if status == "SUCCESS" {
			return ErrJobNotOwned
		}
		return nil
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-own"}, api)
	w.sandbox = &covRunSandbox{}

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "own-success", JobType: string(types.JobTypeDestroy), ConfigSnapshot: covRunSnapshot()},
	})
	if !errors.Is(err, ErrJobNotOwned) {
		t.Fatalf("a refused SUCCESS post must be returned, got %v", err)
	}
}
