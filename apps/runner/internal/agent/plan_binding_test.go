// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// planDigestOf returns a pointer to the lowercase-hex SHA-256 of b, the form a job carries.
func planDigestOf(b []byte) *string {
	sum := sha256.Sum256(b)
	d := hex.EncodeToString(sum[:])
	return &d
}

// planBindAPI serves a fixed plan artifact (or a download error) and a SUCCESS plan job.
type planBindAPI struct {
	*covRunAPI
	artifact    []byte
	downloadErr error
	downloads   []string
}

// DownloadPlanArtifact writes the configured artifact bytes, or fails with the configured error.
func (a *planBindAPI) DownloadPlanArtifact(jobID, destPath string) error {
	a.downloads = append(a.downloads, jobID)
	if a.downloadErr != nil {
		return a.downloadErr
	}
	return os.WriteFile(destPath, a.artifact, 0o600)
}

// newPlanBindAPI builds a planBindAPI whose plan job reads back as SUCCESS.
func newPlanBindAPI(artifact []byte) *planBindAPI {
	api := &planBindAPI{covRunAPI: newCovRunAPI(), artifact: artifact}
	api.getJobFn = func(id string) (*Job, error) { return &Job{ID: id, Status: "SUCCESS"}, nil }
	return api
}

// runBoundDeploy runs executeDeploy for job against api and returns how many times the stage ran,
// the plan file the stage was handed ("" when it was handed none), and executeDeploy's error.
func runBoundDeploy(t *testing.T, api *planBindAPI, job *Job) (runs int, handed string, err error) {
	t.Helper()
	sb := &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		if b, readErr := os.ReadFile(filepath.Join(spec.WorkDir, "plan-apply.out")); readErr == nil {
			handed = string(b)
		}
		return nil
	}}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-bind"}, api)
	w.sandbox = sb
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	err = w.executeDeploy(t.Context(), job, "aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	return sb.runs(), handed, err
}

// boundJob is a DEPLOY job bound to planJobID with the given digest (nil = none carried).
func boundJob(planJobID *string, digest *string) *Job {
	return &Job{
		ID: "bind-deploy", JobType: string(types.JobTypeDeploy),
		ConfigSnapshot: covRunSnapshot(), PlanJobID: planJobID, PlanSHA256: digest,
	}
}

// An apply whose saved plan hashes to the digest the job carries runs that plan.
func TestPlanBinding_MatchAppliesTheReviewedPlan(t *testing.T) {
	plan := []byte("reviewed-plan-bytes")
	planJobID := "plan-1"
	api := newPlanBindAPI(plan)

	runs, handed, err := runBoundDeploy(t, api, boundJob(&planJobID, planDigestOf(plan)))
	if err != nil {
		t.Fatalf("a matching digest must apply: %v", err)
	}
	if runs != 1 {
		t.Fatalf("the stage ran %d time(s), want 1", runs)
	}
	if handed != string(plan) {
		t.Fatalf("the stage was handed %q, want the reviewed plan", handed)
	}
	if len(api.downloads) != 1 || api.downloads[0] != planJobID {
		t.Fatalf("the plan must be fetched once from the bound plan job, got %v", api.downloads)
	}
}

// The digest a job carries is the one the plan job's evidence receipt records, in either case.
func TestPlanBinding_DigestIsTheReceiptDigest(t *testing.T) {
	plan := []byte("reviewed-plan-bytes")
	planJobID := "plan-1"
	upper := strings.ToUpper(verify.PlanSHA256(plan))

	runs, _, err := runBoundDeploy(t, newPlanBindAPI(plan), boundJob(&planJobID, &upper))
	if err != nil || runs != 1 {
		t.Fatalf("the receipt's plan_sha256 must bind the apply (err %v, runs %d)", err, runs)
	}
}

// Every way a bound apply can fail to be shown to run its reviewed plan is a typed refusal, and
// the stage never runs.
func TestPlanBinding_Refusals(t *testing.T) {
	plan := []byte("reviewed-plan-bytes")
	planJobID := "plan-1"
	notADigest := "9f3c1a7e"

	for _, tc := range []struct {
		name     string
		job      *Job
		artifact []byte
		dlErr    error
		getJob   func(string) (*Job, error)
		want     PlanBindingCode
	}{
		{name: "digest differs", job: boundJob(&planJobID, planDigestOf(plan)), artifact: []byte("another-plan"), want: PlanDigestMismatch},
		{name: "digest malformed", job: boundJob(&planJobID, &notADigest), artifact: plan, want: PlanDigestMissing},
		{name: "digest without a plan job", job: boundJob(nil, planDigestOf(plan)), artifact: plan, want: PlanReferenceMissing},
		{name: "artifact cannot be fetched", job: boundJob(&planJobID, planDigestOf(plan)), dlErr: errors.New("plan artifact not found (expired or missing)"), want: PlanArtifactUnavailable},
		{name: "artifact empty", job: boundJob(&planJobID, planDigestOf(plan)), artifact: []byte{}, want: PlanArtifactUnavailable},
		{
			name: "plan job cannot be read", job: boundJob(&planJobID, planDigestOf(plan)), artifact: plan,
			getJob: func(string) (*Job, error) { return nil, errors.New("get job returned status 403") },
			want:   PlanJobUnavailable,
		},
		{
			name: "plan job did not succeed", job: boundJob(&planJobID, planDigestOf(plan)), artifact: plan,
			getJob: func(id string) (*Job, error) { return &Job{ID: id, Status: "FAILED"}, nil },
			want:   PlanJobNotSucceeded,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newPlanBindAPI(tc.artifact)
			api.downloadErr = tc.dlErr
			if tc.getJob != nil {
				api.getJobFn = tc.getJob
			}
			runs, handed, err := runBoundDeploy(t, api, tc.job)
			code, ok := planBindingRefusal(err)
			if !ok {
				t.Fatalf("want a plan-binding refusal %q, got %v", tc.want, err)
			}
			if code != tc.want {
				t.Fatalf("refusal code = %q, want %q (%v)", code, tc.want, err)
			}
			if runs != 0 || handed != "" {
				t.Fatalf("a refused apply must not reach the stage (runs %d, handed %q)", runs, handed)
			}
			if !strings.HasPrefix(err.Error(), "Apply refused: ") || !strings.Contains(err.Error(), "Run a new plan") {
				t.Errorf("the refusal must read as an instruction to the user, got %q", err)
			}
		})
	}
}

// A job that names a plan job but carries no digest of it is refused before anything is fetched:
// there is no path from a named plan to an apply of a plan computed on the runner, whether the
// digest is absent or blank, and whether or not the saved plan could be downloaded.
func TestPlanBinding_NamedPlanWithoutDigestIsRefused(t *testing.T) {
	planJobID := "plan-1"
	blank := "  "

	for name, digest := range map[string]*string{"absent digest": nil, "blank digest": &blank} {
		t.Run(name, func(t *testing.T) {
			api := newPlanBindAPI([]byte("saved-plan"))
			runs, handed, err := runBoundDeploy(t, api, boundJob(&planJobID, digest))
			if code, ok := planBindingRefusal(err); !ok || code != PlanDigestMissing {
				t.Fatalf("want %q, got %v", PlanDigestMissing, err)
			}
			if runs != 0 || handed != "" {
				t.Fatalf("a refused apply must not reach the stage (runs %d, handed %q)", runs, handed)
			}
			if len(api.downloads) != 0 {
				t.Fatalf("no plan may be fetched for a refused apply (downloads %v)", api.downloads)
			}
			if !strings.Contains(err.Error(), "Run a new plan, review it, and apply that plan.") {
				t.Errorf("the refusal must tell the user to plan again, got %q", err)
			}
		})
	}

	t.Run("no fallback to a new plan when the saved plan is unavailable", func(t *testing.T) {
		api := newPlanBindAPI(nil)
		api.downloadErr = errors.New("plan artifact not found (expired or missing)")
		runs, _, err := runBoundDeploy(t, api, boundJob(&planJobID, nil))
		if _, ok := planBindingRefusal(err); !ok || runs != 0 {
			t.Fatalf("the apply must be refused, not re-planned (err %v, runs %d)", err, runs)
		}
		for _, c := range api.getLogChunks() {
			if strings.Contains(c.chunk, "will re-plan") {
				t.Fatalf("a named plan must never fall back to a new plan, log said %q", c.chunk)
			}
		}
	})
}

// A job that names no plan job and carries no digest is a system re-apply (auto-heal, the build
// chain): it is not bound, no plan is fetched, and the stage plans afresh.
func TestPlanBinding_SystemReapplyWithoutPlanPlansAfresh(t *testing.T) {
	api := newPlanBindAPI([]byte("unused"))
	runs, handed, err := runBoundDeploy(t, api, boundJob(nil, nil))
	if err != nil || runs != 1 {
		t.Fatalf("the deploy must run (err %v, runs %d)", err, runs)
	}
	if handed != "" || len(api.downloads) != 0 {
		t.Fatalf("no plan must be fetched (handed %q, downloads %v)", handed, api.downloads)
	}
}

// A refused apply settles the job FAILED with the refusal's code in its metadata and its message
// as the job error.
func TestPlanBinding_RefusalIsPostedOnTheFailedJob(t *testing.T) {
	plan := []byte("reviewed-plan-bytes")
	planJobID := "plan-1"
	api := newPlanBindAPI([]byte("another-plan"))
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-bind"}, api)
	sb := &covRunSandbox{}
	w.sandbox = sb

	err := w.executeJob(t.Context(), &ClaimResponse{Job: boundJob(&planJobID, planDigestOf(plan))})
	if code, ok := planBindingRefusal(err); !ok || code != PlanDigestMismatch {
		t.Fatalf("want %q, got %v", PlanDigestMismatch, err)
	}
	if sb.runs() != 0 {
		t.Fatalf("the stage ran %d time(s) for a refused apply", sb.runs())
	}
	var posted bool
	for _, u := range api.getStatusUpdates() {
		if u.status != "FAILED" {
			continue
		}
		posted = true
		if u.metadata[planBindingMetadataKey] != string(PlanDigestMismatch) {
			t.Errorf("FAILED metadata = %v, want %s=%s", u.metadata, planBindingMetadataKey, PlanDigestMismatch)
		}
		if !strings.Contains(u.errMsg, "is not the plan that was reviewed") {
			t.Errorf("job error = %q, want the user-readable refusal", u.errMsg)
		}
	}
	if !posted {
		t.Fatal("the refused apply never settled FAILED")
	}
}
