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
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
)

const testApprovalID = "6b21d8f4-0c5e-4a93-9f27-3d81b6e5c704"

// projApproval is the approvals half of projServer: a DEPLOY or DESTROY sent without approval_id is
// refused 403 approval_required, POST /api/approvals answers `initial`, and each GET answers the
// next of `statuses` (repeating the last).
type projApproval struct {
	mu sync.Mutex
	// initial is the status the request answers with; empty is pending.
	initial string
	// statuses are what the polls answer in turn; empty is approved.
	statuses []string
	polls    int
	// requests is every POST /api/approvals body.
	requests []map[string]any
	// deploys is what GET /api/jobs lists, for a `--latest-plan` looking for the plan it names.
	deploys []map[string]any
}

// approvalResponse answers the requests the approvals half owns, and reports whether it did.
func (s *projServer) approvalResponse(w http.ResponseWriter, r *http.Request, enc *json.Encoder) bool {
	a := s.approval
	if a == nil {
		return false
	}
	p := r.URL.Path
	body := map[string]any{}
	if post, ok := s.lastPost(); ok {
		body = post.Body
	}
	view := func(status string) map[string]any {
		return map[string]any{"approval": map[string]any{
			"id": testApprovalID, "status": status, "operation": body["operation"], "project_id": "p1",
			"environment_id": "e1", "plan_job_id": body["plan_job_id"], "digest_prefix": "a1b2c3d4",
			"expires_at": "2026-12-01T00:00:00Z", "decided_at": nil, "consumed_job_id": nil,
		}, "approve_path": "/approvals/" + testApprovalID}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case p == "/api/approvals" && r.Method == http.MethodPost:
		a.requests = append(a.requests, body)
		status := a.initial
		if status == "" {
			status = api.ApprovalStatusPending
		}
		w.WriteHeader(http.StatusCreated)
		_ = enc.Encode(view(status))
		return true
	case strings.HasPrefix(p, "/api/approvals/"):
		status := api.ApprovalStatusApproved
		if len(a.statuses) > 0 {
			status = a.statuses[min(a.polls, len(a.statuses)-1)]
		}
		a.polls++
		_ = enc.Encode(view(status))
		return true
	case p == "/api/jobs" && r.Method == http.MethodGet:
		_ = enc.Encode(map[string]any{"jobs": a.deploys, "total": len(a.deploys), "limit": 50, "offset": 0})
		return true
	case p == "/api/jobs" && r.Method == http.MethodPost:
		jt := body["job_type"]
		if (jt == "DEPLOY" || jt == "DESTROY") && body["approval_id"] == nil {
			w.WriteHeader(http.StatusForbidden)
			_ = enc.Encode(map[string]any{"error": "This deploy needs a person's approval.", "code": "approval_required"})
			return true
		}
	}
	return false
}

// jobPosts is every POST /api/jobs body, in order.
func (s *projServer) jobPosts() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []map[string]any
	for _, p := range s.posts {
		if p.Path == "/api/jobs" {
			out = append(out, p.Body)
		}
	}
	return out
}

// fastApprovalPolls makes the approval and job polls immediate for the test.
func fastApprovalPolls(t *testing.T) {
	t.Helper()
	prevA, prevJ := approvalPollInterval, jobPollInterval
	approvalPollInterval, jobPollInterval = time.Millisecond, time.Millisecond
	t.Cleanup(func() { approvalPollInterval, jobPollInterval = prevA, prevJ })
}

// ── the flow, at the approvalClient seam ────────────────────────────────────────────────────

// scriptedApprovals is an approvalClient whose request answers `initial` and whose reads answer
// `reads` in turn (repeating the last), or fail with readErr.
type scriptedApprovals struct {
	initial    string
	requestErr error
	reads      []string
	readErrs   []error
	n          int
	requested  []string
}

func (s *scriptedApprovals) RequestApproval(planJobID, operation, reason string) (*api.ApprovalResponse, error) {
	s.requested = append(s.requested, planJobID+"/"+operation)
	if s.requestErr != nil {
		return nil, s.requestErr
	}
	return &api.ApprovalResponse{
		Approval:    api.Approval{ID: testApprovalID, Status: s.initial, DigestPrefix: "a1b2c3d4", PlanJobID: planJobID},
		ApprovePath: "/approvals/" + testApprovalID,
	}, nil
}

func (s *scriptedApprovals) GetApproval(id string) (*api.ApprovalResponse, error) {
	i := s.n
	s.n++
	if i < len(s.readErrs) && s.readErrs[i] != nil {
		return nil, s.readErrs[i]
	}
	status := api.ApprovalStatusPending
	if len(s.reads) > 0 {
		status = s.reads[min(i, len(s.reads)-1)]
	}
	return &api.ApprovalResponse{Approval: api.Approval{ID: id, Status: status}}, nil
}

// approvalTestPrinter is a Printer over one buffer.
func approvalTestPrinter(mode Mode) (*Printer, *bytes.Buffer) {
	var buf bytes.Buffer
	return &Printer{Out: &buf, Err: &buf, Format: ui.FormatTable, Mode: mode}, &buf
}

func TestApprovalRequired_OnlyTheControlPlanesRefusal(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{&api.APIError{StatusCode: http.StatusForbidden, Code: "approval_required"}, true},
		{errors.Join(errors.New("failed to queue job"), &api.APIError{StatusCode: http.StatusForbidden, Code: "approval_required"}), true},
		{&api.APIError{StatusCode: http.StatusForbidden, Code: "insufficient_scope"}, false},
		{&api.APIError{StatusCode: http.StatusConflict, Code: "approval_required"}, false},
		{errors.New("approval_required"), false},
		{nil, false},
	}
	for _, c := range cases {
		if got := approvalRequired(c.err); got != c.want {
			t.Errorf("approvalRequired(%v) = %v, want %v", c.err, got, c.want)
		}
	}
	// The control plane's code exits 9, like a confirmation: only a person can give it.
	if e := clierr.From(&api.APIError{StatusCode: http.StatusForbidden, Code: "approval_required"}); e.Exit != clierr.ExitInputRequired {
		t.Errorf("approval_required exits %d, want 9", e.Exit)
	}
}

func TestApprovalPageURL_JoinsThePathToThisCLIsOrigin(t *testing.T) {
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://cp.example.internal/")
	for path, want := range map[string]string{
		"/approvals/x": "https://cp.example.internal/approvals/x",
		"approvals/x":  "https://cp.example.internal/approvals/x",
		"":             "https://cp.example.internal/approvals/" + testApprovalID,
	} {
		if got := approvalPageURL(path, testApprovalID); got != want {
			t.Errorf("approvalPageURL(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestObtainApproval_Outcomes(t *testing.T) {
	fastApprovalPolls(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://cp.example.internal")
	cases := []struct {
		name    string
		c       *scriptedApprovals
		mode    Mode
		wait    approvalWait
		exit    int
		code    string
		says    []string
		polls   int
		approve bool
	}{
		{name: "already approved", c: &scriptedApprovals{initial: "approved"}, approve: true, says: []string{"is approved"}},
		{name: "approved after waiting", c: &scriptedApprovals{initial: "pending", reads: []string{"pending", "approved"}},
			approve: true, polls: 2, says: []string{"https://cp.example.internal/approvals/" + testApprovalID, "a1b2c3d4", "was approved"}},
		{name: "rejected", c: &scriptedApprovals{initial: "pending", reads: []string{"rejected"}},
			exit: clierr.ExitForbidden, code: clierr.CodeApprovalRejected, polls: 1},
		{name: "expired while waiting", c: &scriptedApprovals{initial: "pending", reads: []string{"expired"}},
			exit: clierr.ExitConflict, code: clierr.CodeApprovalInvalid, polls: 1},
		{name: "superseded at request", c: &scriptedApprovals{initial: "superseded"},
			exit: clierr.ExitConflict, code: clierr.CodeApprovalInvalid, says: []string{"plan again"}},
		{name: "--no-wait", c: &scriptedApprovals{initial: "pending"}, wait: approvalWait{NoWait: true, Rerun: "run alethia project deploy --plan-job-id p9 --yes"},
			exit: clierr.ExitInputRequired, code: clierr.CodeApprovalRequired, says: []string{"--plan-job-id p9"}},
		{name: "agent mode does not wait", c: &scriptedApprovals{initial: "pending"}, mode: Mode{Agent: true},
			exit: clierr.ExitInputRequired, code: clierr.CodeApprovalRequired, says: []string{"run this command again"}},
		{name: "a deadline", c: &scriptedApprovals{initial: "pending"}, wait: approvalWait{Timeout: 5 * time.Millisecond},
			exit: clierr.ExitWaitTimeout, code: clierr.CodeWaitTimeout, polls: -1},
		{name: "a transient read failure is retried", c: &scriptedApprovals{initial: "pending",
			readErrs: []error{&api.APIError{StatusCode: http.StatusServiceUnavailable}}, reads: []string{"approved", "approved"}},
			approve: true, polls: 2},
		{name: "a lasting read failure ends the wait", c: &scriptedApprovals{initial: "pending",
			readErrs: []error{&api.APIError{StatusCode: http.StatusNotFound, Message: "gone"}}},
			exit: clierr.ExitNotFound, polls: 1},
		{name: "the request fails", c: &scriptedApprovals{requestErr: &api.APIError{StatusCode: http.StatusConflict, Code: "plan_not_approvable", Message: "plan again"}},
			exit: clierr.ExitConflict, code: "plan_not_approvable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, out := approvalTestPrinter(tc.mode)
			id, err := obtainApproval(context.Background(), p, tc.c, "plan-1", "deploy", tc.wait)
			if tc.approve {
				if err != nil || id != testApprovalID {
					t.Fatalf("got %q, %v; want the approved id", id, err)
				}
			} else {
				e := clierr.From(err)
				if e == nil || e.Exit != tc.exit || (tc.code != "" && e.Code != tc.code) {
					t.Fatalf("got %+v, want exit %d code %q", e, tc.exit, tc.code)
				}
				if tc.code != "plan_not_approvable" && tc.exit != clierr.ExitNotFound && (e.Operation == nil || e.Operation.ID != testApprovalID) {
					t.Errorf("the error does not name the approval: %+v", e)
				}
				out.WriteString(e.Message + " " + e.Hint)
			}
			for _, want := range tc.says {
				if !strings.Contains(out.String(), want) {
					t.Errorf("output does not say %q:\n%s", want, out.String())
				}
			}
			if tc.polls >= 0 && tc.c.n != tc.polls {
				t.Errorf("polled %d times, want %d", tc.c.n, tc.polls)
			}
			if len(tc.c.requested) != 1 || tc.c.requested[0] != "plan-1/deploy" {
				t.Errorf("requested %v, want one approval of plan-1 to deploy", tc.c.requested)
			}
		})
	}
}

func TestObtainApproval_AnInterruptLeavesItPending(t *testing.T) {
	fastApprovalPolls(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p, _ := approvalTestPrinter(Mode{})
	_, err := obtainApproval(ctx, p, &scriptedApprovals{initial: "pending"}, "plan-1", "destroy", approvalWait{})
	if e := clierr.From(err); e.Exit != clierr.ExitInterrupted || !strings.Contains(e.Message, "still pending") {
		t.Errorf("got %+v", e)
	}
}

func TestQueueWithApproval_OnlyARefusalForWantOfAnApprovalAsksForOne(t *testing.T) {
	refused := &api.APIError{StatusCode: http.StatusForbidden, Code: "approval_required"}
	p, _ := approvalTestPrinter(Mode{})
	plan := func() (string, error) { return "plan-1", nil }

	// Queued at once: no approval, no plan lookup.
	looked := false
	got, err := queueWithApproval(context.Background(), p, &scriptedApprovals{}, "deploy",
		func() (string, error) { looked = true; return "", nil }, approvalWait{},
		func(string) (string, error) { return "job", nil })
	if err != nil || got != "job" || looked {
		t.Errorf("a job that needs no approval: %q %v (looked up the plan: %v)", got, err, looked)
	}
	// Another refusal, or no approvals client, passes through unchanged.
	other := &api.APIError{StatusCode: http.StatusConflict}
	if _, err := queueWithApproval(context.Background(), p, &scriptedApprovals{}, "deploy", plan, approvalWait{},
		func(string) (string, error) { return "", other }); !errors.Is(err, other) {
		t.Errorf("another refusal was not passed through: %v", err)
	}
	if _, err := queueWithApproval(context.Background(), p, nil, "deploy", plan, approvalWait{},
		func(string) (string, error) { return "", refused }); !errors.Is(err, refused) {
		t.Errorf("without an approvals client the refusal must pass through: %v", err)
	}
	// The plan cannot be named.
	boom := errors.New("no plan")
	if _, err := queueWithApproval(context.Background(), p, &scriptedApprovals{initial: "approved"}, "destroy",
		func() (string, error) { return "", boom }, approvalWait{},
		func(string) (string, error) { return "", refused }); !errors.Is(err, boom) {
		t.Errorf("a plan that cannot be named must end it: %v", err)
	}
	// Approved: queued again, with the approval.
	var sent []string
	got, err = queueWithApproval(context.Background(), p, &scriptedApprovals{initial: "approved"}, "deploy", plan, approvalWait{},
		func(id string) (string, error) {
			sent = append(sent, id)
			if id == "" {
				return "", refused
			}
			return "job", nil
		})
	if err != nil || got != "job" || len(sent) != 2 || sent[1] != testApprovalID {
		t.Errorf("got %q %v, sent %v", got, err, sent)
	}
}

func TestApprovalsAwaited(t *testing.T) {
	if approvalsAwaited(nil) != nil {
		t.Error("no approval asked for is no error")
	}
	one := clierr.New(clierr.CodeApprovalRequired, "approval a is waiting")
	if approvalsAwaited([]*clierr.Error{one}) != one {
		t.Error("one approval is its own error")
	}
	two := clierr.New(clierr.CodeApprovalRequired, "approval b is waiting")
	two.Hint = "run b"
	one.Hint = "run a"
	e := clierr.From(approvalsAwaited([]*clierr.Error{one, two}))
	if e.Exit != clierr.ExitInputRequired || !strings.Contains(e.Message, "2 deploys") ||
		!strings.Contains(e.Message, "approval b") || !strings.Contains(e.Hint, "run a") || !strings.Contains(e.Hint, "run b") {
		t.Errorf("got %+v", e)
	}
}

// ── through the commands ─────────────────────────────────────────────────────────────────────

func TestProjDeploy_WaitsForAnApprovalThenDeploysWithIt(t *testing.T) {
	fastApprovalPolls(t)
	s := &projServer{envs: projSampleEnvs(), approval: &projApproval{statuses: []string{"pending", "approved"}}}
	h := projEnv(t, s)
	t.Cleanup(func() { projectApplyNoWait = false })

	code, _, stderr := projExitCode(t, h, "project", "deploy", "--project", "web", "--runner-id", "r1",
		"--env", "production", "--plan-job-id", "j0", "--yes", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	jobs := s.jobPosts()
	if len(jobs) != 2 || jobs[0]["approval_id"] != nil || jobs[1]["approval_id"] != testApprovalID || jobs[1]["plan_job_id"] != "j0" {
		t.Fatalf("want the deploy refused, then sent again with the approval: %+v", jobs)
	}
	if len(s.approval.requests) != 1 || s.approval.requests[0]["plan_job_id"] != "j0" || s.approval.requests[0]["operation"] != "deploy" {
		t.Errorf("the approval must be asked for the deploy of plan j0: %+v", s.approval.requests)
	}
	for _, want := range []string{"/approvals/" + testApprovalID, "a1b2c3d4", "was approved"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr does not say %q:\n%s", want, stderr)
		}
	}
}

func TestProjDeploy_NoWaitExitsNineWithThePage(t *testing.T) {
	s := &projServer{envs: projSampleEnvs(), approval: &projApproval{}}
	h := projEnv(t, s)
	t.Cleanup(func() { projectApplyNoWait = false })

	code, _, stderr := projExitCode(t, h, "project", "deploy", "--project", "web", "--env", "production",
		"--plan-job-id", "j0", "--yes", "--no-input", "--no-wait", "--output", "json")
	if code != clierr.ExitInputRequired {
		t.Fatalf("exit %d, want 9:\n%s", code, stderr)
	}
	env := lastErrorEnvelope(t, stderr)
	if env.Error.Code != clierr.CodeApprovalRequired || env.Error.Operation == nil || env.Error.Operation.ID != testApprovalID ||
		!strings.Contains(env.Error.Message, "/approvals/"+testApprovalID) ||
		!strings.Contains(env.Error.Hint, "alethia project deploy --project web --env production --plan-job-id j0 --yes") {
		t.Errorf("error = %+v", env.Error)
	}
	if jobs := s.jobPosts(); len(jobs) != 1 {
		t.Errorf("a deploy that did not wait must queue nothing more: %+v", jobs)
	}
	if s.approval.polls != 0 {
		t.Errorf("a deploy that did not wait polled the approval %d times", s.approval.polls)
	}
}

// projDefaultEnvID is the id of the default environment among projSampleEnvs.
func projDefaultEnvID(t *testing.T) string {
	t.Helper()
	for _, e := range projSampleEnvs() {
		if e["is_default"] == true {
			id, _ := e["id"].(string)
			return id
		}
	}
	t.Fatal("projSampleEnvs has no default environment")
	return ""
}

func TestApply_DeploysEachPreviewedPlanOnceApproved(t *testing.T) {
	fastApprovalPolls(t)
	s := &projServer{envs: applyDemoEnvs(), approval: &projApproval{}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, _, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	var shape []string
	for _, j := range s.jobPosts() {
		mark := j["job_type"].(string)
		if j["approval_id"] == testApprovalID {
			mark += "+approval"
		}
		shape = append(shape, mark)
	}
	if got := strings.Join(shape, " "); got != "PLAN DEPLOY DEPLOY+approval PLAN DEPLOY DEPLOY+approval" {
		t.Errorf("each environment is previewed, refused, approved and deployed: %s", got)
	}
	if len(s.approval.requests) != 2 {
		t.Errorf("want one approval per environment: %+v", s.approval.requests)
	}
}

func TestApply_NoWaitAsksForEveryApprovalAndExitsNine(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), approval: &projApproval{}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, _, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--no-wait", "--output", "json")
	if code != clierr.ExitInputRequired {
		t.Fatalf("exit %d, want 9:\n%s", code, stderr)
	}
	env := lastErrorEnvelope(t, stderr)
	if env.Error.Code != clierr.CodeApprovalRequired || !strings.Contains(env.Error.Message, "2 deploys") ||
		!strings.Contains(env.Error.Hint, "--env prod --plan-job-id j1") || !strings.Contains(env.Error.Hint, "--env dev-1 --plan-job-id j1") {
		t.Errorf("error = %+v", env.Error)
	}
	if len(s.approval.requests) != 2 || s.approval.polls != 0 {
		t.Errorf("want both approvals asked for and none waited on: %d requests, %d polls", len(s.approval.requests), s.approval.polls)
	}
}

// ── alethia approve ─────────────────────────────────────────────────────────────────────────

func TestApprove_OpensThePageAndSendsNothing(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	t.Cleanup(func() { approveNoBrowser = false })

	// Not a terminal: the page is printed.
	code, stdout, stderr := projExitCode(t, h, "approve", testApprovalID)
	if code != 0 || !strings.Contains(stdout, "/approvals/"+testApprovalID) {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}

	// A terminal: the page is opened.
	projTTY(t)
	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	t.Cleanup(func() { openBrowser = prev })
	if code, _, stderr := projExitCode(t, h, "approve", testApprovalID); code != 0 || len(opened) != 1 ||
		!strings.HasSuffix(opened[0], "/approvals/"+testApprovalID) {
		t.Fatalf("exit %d, opened %v:\n%s", code, opened, stderr)
	}
	// --no-browser prints instead; a browser that will not open is said, and the page printed.
	if code, stdout, _ := projExitCode(t, h, "approve", testApprovalID, "--no-browser"); code != 0 || len(opened) != 1 ||
		!strings.Contains(stdout, testApprovalID) {
		t.Errorf("--no-browser opened a browser or printed nothing: exit %d, %q", code, stdout)
	}
	approveNoBrowser = false
	openBrowser = func(string) error { return errors.New("no browser") }
	if code, stdout, stderr := projExitCode(t, h, "approve", testApprovalID); code != 0 ||
		!strings.Contains(stderr, "Could not open a browser") || !strings.Contains(stdout, testApprovalID) {
		t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}

	for _, r := range s.reads {
		if strings.Contains(r, "approvals") {
			t.Errorf("approve sent a request: %s", r)
		}
	}
}

func TestApprove_RefusesWhatIsNotAnApprovalID(t *testing.T) {
	h := projEnv(t, &projServer{})
	if code, _, _ := projExitCode(t, h, "approve", "not-an-id"); code != clierr.ExitUsage {
		t.Errorf("a malformed id exits %d, want 8", code)
	}
	if code, _, stderr := projExitCode(t, h, "approve", "--no-input"); code != clierr.ExitInputRequired ||
		!strings.Contains(stderr, "approval id") {
		t.Errorf("a missing id with nobody to ask exits %d, want 9:\n%s", code, stderr)
	}
}

func TestPromptApprovalID_OnATerminal(t *testing.T) {
	projTTY(t)
	prev := runHuhForm
	t.Cleanup(func() { runHuhForm = prev })
	p, _ := approvalTestPrinter(Mode{})

	// The form is answered with nothing: what came back is not an approval id.
	runHuhForm = func(...*huh.Group) error { return nil }
	if e := clierr.From(runApprove(p, nil, true)); e == nil || e.Exit != clierr.ExitUsage {
		t.Errorf("an empty answer: %+v", e)
	}
	// The form is dismissed: that is the answer.
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if err := runApprove(p, nil, true); !errors.Is(err, errBoom) {
		t.Errorf("a dismissed form: %v", err)
	}
}

// jobPostsOfType is every POST /api/jobs body that queues jobType, in order. `alethia apply`
// previews each environment before it deploys it, so a test about its deploys reads only these.
func (s *projServer) jobPostsOfType(jobType string) []map[string]any {
	var out []map[string]any
	for _, b := range s.jobPosts() {
		if b["job_type"] == jobType {
			out = append(out, b)
		}
	}
	return out
}

func TestApply_APreviewThatFailsDeploysNothing(t *testing.T) {
	fastApprovalPolls(t)
	s := &projServer{envs: applyDemoEnvs(), jobStatuses: []string{"FAILED"}, jobErrMsg: "provider error"}
	h := projEnv(t, s)
	applyResetFlags()
	t.Cleanup(applyResetFlags)
	path := applyWriteManifest(t, applyDemoManifest)

	code, _, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--output", "json")
	if code != clierr.ExitOperationFailed {
		t.Fatalf("exit %d, want 13:\n%s", code, stderr)
	}
	if env := lastErrorEnvelope(t, stderr); !strings.Contains(env.Error.Message, "preview of prod") ||
		!strings.Contains(env.Error.Message, "not deployed") {
		t.Errorf("error = %+v", env.Error)
	}
	if deploys := s.jobPostsOfType("DEPLOY"); len(deploys) != 0 {
		t.Errorf("a failed preview deployed: %+v", deploys)
	}
}

func TestApply_ARejectedApprovalExitsFiveAndPrintsThePlan(t *testing.T) {
	fastApprovalPolls(t)
	s := &projServer{envs: applyDemoEnvs(), approval: &projApproval{statuses: []string{"rejected"}},
		jobMeta: map[string]any{"plan_result": map[string]any{"resource_changes": []any{
			map[string]any{"change": map[string]any{"actions": []any{"create"}}},
		}}}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	code, _, stderr := projExitCode(t, h, "apply", "--file", path, "--yes", "--runner", "primary", "--no-input")
	if code != clierr.ExitForbidden {
		t.Fatalf("exit %d, want 5:\n%s", code, stderr)
	}
	for _, want := range []string{"prod Plan: 1 to create", "deploy prod", "was rejected"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr does not say %q:\n%s", want, stderr)
		}
	}
	if len(s.jobPostsOfType("DEPLOY")) != 1 {
		t.Errorf("a rejected approval must queue nothing more: %+v", s.jobPosts())
	}
}
