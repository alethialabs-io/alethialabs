// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The PURE half of the approval path (#7454): the deploy is automatic because the owner listed the
// environment, and the destroy is approved by a person, never queued without one. Driven with a fake
// CLI and a fake approver, so every branch is exercised on each PR without a console or a cloud.

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

const testApprovalID = "0b9b6f43-3c1e-4d5e-9a51-6f0e2d8c7a11"

// approvalEnvelope is the alethia.error/v1 line `project destroy --no-wait --output json` writes for
// a pending approval, preceded by the human warning the CLI prints first.
const approvalEnvelope = "! This destroy needs a person's approval. Approve it at http://localhost:3000/approvals/" +
	testApprovalID + " — the page must show plan p with a digest starting 1a2b3c4d.\n" +
	`{"error":{"code":"approval_required","class":"input_required","exit_code":9,"message":"approval ` +
	testApprovalID + ` is waiting","hint":null,"docs_url":null,"retryable":false,"retry_after_seconds":null,` +
	`"request_id":null,"http_status":null,"operation":{"id":"` + testApprovalID + `","type":"APPROVAL"}},"schema":"alethia.error/v1"}` + "\n"

// fakeCLIDemoAdmin records what the harness asked a person to do.
type fakeCLIDemoAdmin struct {
	autoApproved [][2]string
	approved     [][2]string
	approveErr   error
}

func (f *fakeCLIDemoAdmin) AutoApproveEnvironment(_ context.Context, projectID, envName string) error {
	f.autoApproved = append(f.autoApproved, [2]string{projectID, envName})
	return nil
}

func (f *fakeCLIDemoAdmin) Approve(_ context.Context, approvalID, confirmEnvName string) error {
	f.approved = append(f.approved, [2]string{approvalID, confirmEnvName})
	return f.approveErr
}

// fakeCLIDemoExec answers each call with the next scripted reply and records the argv.
type fakeCLIDemoExec struct {
	replies []fakeReply
	calls   [][]string
}

type fakeReply struct {
	out  string
	code int
	err  error
}

func (f *fakeCLIDemoExec) run(_ context.Context, _ *CLIDemoRun, argv []string, _ time.Duration) (string, int, error) {
	f.calls = append(f.calls, argv)
	if len(f.calls) > len(f.replies) {
		return "", -1, errors.New("unscripted call")
	}
	r := f.replies[len(f.calls)-1]
	return r.out, r.code, r.err
}

func approvalTestRun(admin CLIDemoAdmin) *CLIDemoRun {
	return &CLIDemoRun{ProjectID: "11111111-2222-4333-8444-555555555555", EnvName: "36000000000-1", Admin: admin}
}

// TestCLIDemoApprovalIDFromEnvelope pins what counts as "the CLI stopped for an approval": exit 9
// AND an approval_required envelope naming an APPROVAL by UUID. Each other shape is refused, because
// exit 9 is also a confirmation the CLI could not ask for.
func TestCLIDemoApprovalIDFromEnvelope(t *testing.T) {
	id, err := cliDemoApprovalIDFrom(approvalEnvelope, 9)
	if err != nil || id != testApprovalID {
		t.Fatalf("got (%q, %v), want (%q, nil)", id, err, testApprovalID)
	}
	refused := map[string]struct {
		out  string
		code int
	}{
		"another exit code": {approvalEnvelope, 1},
		"no envelope":       {"approval needed, see the console\n", 9},
		"a confirmation, not an approval": {
			`{"error":{"code":"confirmation_required","message":"pass --yes","operation":null}}` + "\n", 9},
		"no operation": {`{"error":{"code":"approval_required","message":"m","operation":null}}` + "\n", 9},
		"an operation that is not an approval": {
			`{"error":{"code":"approval_required","operation":{"id":"` + testApprovalID + `","type":"JOB"}}}` + "\n", 9},
		"an id that is not a UUID": {
			`{"error":{"code":"approval_required","operation":{"id":"abc","type":"APPROVAL"}}}` + "\n", 9},
	}
	for name, c := range refused {
		if got, err := cliDemoApprovalIDFrom(c.out, c.code); err == nil {
			t.Errorf("%s: accepted, returned %q", name, got)
		}
	}
}

// TestCLIDemoDestroyBeatGoesThroughTheApproval drives the real `destroy` beat: the --no-wait run
// requests the approval, the owner approves THAT id typing the environment's name, and the --wait
// rerun queues with it.
func TestCLIDemoDestroyBeatGoesThroughTheApproval(t *testing.T) {
	b := cliDemoBeatByID(t, "destroy")
	if b.Approval == nil {
		t.Fatal("the destroy beat has no Approval — a service token's destroy is refused 403 approval_required (#7454)")
	}
	admin := &fakeCLIDemoAdmin{}
	run := approvalTestRun(admin)
	x := &fakeCLIDemoExec{replies: []fakeReply{
		{out: approvalEnvelope, code: 9},
		{out: "Approval " + testApprovalID + " of plan p is approved; queueing the destroy.\nDESTROY job queued\n"},
	}}
	out, err := performCLIDemoApprovalBeat(context.Background(), run, b, time.Minute, x.run)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "queueing the destroy") {
		t.Errorf("returned %q, want the rerun's output", out)
	}
	if run.ApprovalID != testApprovalID {
		t.Errorf("run.ApprovalID = %q, want %q", run.ApprovalID, testApprovalID)
	}
	if want := [][2]string{{testApprovalID, run.EnvName}}; !slices.Equal(admin.approved, want) {
		t.Errorf("approved %v, want %v (the requested id, confirmed with the environment's name)", admin.approved, want)
	}
	if len(x.calls) != 2 {
		t.Fatalf("ran the CLI %d time(s), want 2", len(x.calls))
	}
	first, rerun := x.calls[0], x.calls[1]
	for _, want := range []string{"destroy", "--yes", "--no-wait", "--output", "json", "--no-input", run.ProjectID, run.EnvName} {
		if !slices.Contains(first, want) {
			t.Errorf("the first run %v lacks %q", first, want)
		}
	}
	if slices.Contains(first, "--wait") {
		t.Errorf("the first run %v passes --wait, which the CLI refuses beside --no-wait", first)
	}
	for _, want := range []string{"destroy", "--yes", "--wait", run.ProjectID, run.EnvName} {
		if !slices.Contains(rerun, want) {
			t.Errorf("the rerun %v lacks %q", rerun, want)
		}
	}
	if slices.Contains(rerun, "--no-wait") {
		t.Errorf("the rerun %v passes --no-wait — it must wait for the destroy the spine's teardown relies on", rerun)
	}
}

// TestCLIDemoDestroyBeatFailsEveryOtherWay — each branch names its own cause, and none of them asks
// the owner to approve something the CLI did not request, or reruns after a refused decision.
func TestCLIDemoDestroyBeatFailsEveryOtherWay(t *testing.T) {
	b := cliDemoBeatByID(t, "destroy")
	approved := "Approval " + testApprovalID + " is approved; queueing the destroy.\n"
	cases := []struct {
		name       string
		replies    []fakeReply
		approveErr error
		admin      bool
		wantErr    string
		wantCalls  int
		wantAsked  int
	}{
		{name: "queued without an approval", replies: []fakeReply{{out: "DESTROY job queued\n"}},
			admin: true, wantErr: "WITHOUT a person's approval", wantCalls: 1},
		{name: "the CLI could not run", replies: []fakeReply{{code: -1, err: errors.New("no such file")}},
			admin: true, wantErr: "could not be run", wantCalls: 1},
		{name: "a different refusal", replies: []fakeReply{{out: `{"error":{"code":"forbidden"}}` + "\n", code: 3}},
			admin: true, wantErr: "exited 3", wantCalls: 1},
		{name: "the approval is refused", replies: []fakeReply{{out: approvalEnvelope, code: 9}},
			approveErr: errors.New("self_approval"), admin: true, wantErr: "could not approve", wantCalls: 1, wantAsked: 1},
		{name: "the rerun fails", replies: []fakeReply{{out: approvalEnvelope, code: 9}, {out: "boom", code: 1}},
			admin: true, wantErr: "still exited 1", wantCalls: 2, wantAsked: 1},
		{name: "the rerun used another approval", replies: []fakeReply{{out: approvalEnvelope, code: 9},
			{out: strings.ReplaceAll(approved, testApprovalID, "99999999-9999-4999-8999-999999999999")}},
			admin: true, wantErr: "does not name approval", wantCalls: 2, wantAsked: 1},
		{name: "nobody to approve", replies: nil, admin: false, wantErr: "no CLIDemoAdmin", wantCalls: 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			admin := &fakeCLIDemoAdmin{approveErr: c.approveErr}
			run := approvalTestRun(admin)
			if !c.admin {
				run.Admin = nil
			}
			x := &fakeCLIDemoExec{replies: c.replies}
			_, err := performCLIDemoApprovalBeat(context.Background(), run, b, time.Minute, x.run)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("err = %v, want one containing %q", err, c.wantErr)
			}
			if len(x.calls) != c.wantCalls {
				t.Errorf("ran the CLI %d time(s), want %d", len(x.calls), c.wantCalls)
			}
			if len(admin.approved) != c.wantAsked {
				t.Errorf("asked the owner to approve %d time(s), want %d", len(admin.approved), c.wantAsked)
			}
		})
	}
}

// TestCLIDemoProjectEnvBeatListsTheEnvOnTheToken — the deploy is automatic only because the owner
// listed the run's environment (decision D2), right after the beat that created it and before the
// enqueue phase deploys it.
func TestCLIDemoProjectEnvBeatListsTheEnvOnTheToken(t *testing.T) {
	b := cliDemoBeatByID(t, "project-env")
	if b.OrgAdmin == nil {
		t.Fatal("the project-env beat has no OrgAdmin — nothing lists the run's environment on the token, " +
			"and the apply beat is refused 403 approval_required (#7454)")
	}
	admin := &fakeCLIDemoAdmin{}
	run := approvalTestRun(admin)
	if err := b.OrgAdmin(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if want := [][2]string{{run.ProjectID, run.EnvName}}; !slices.Equal(admin.autoApproved, want) {
		t.Errorf("listed %v, want %v", admin.autoApproved, want)
	}
	run.Admin = nil
	if err := b.OrgAdmin(context.Background(), run); err == nil {
		t.Error("with no CLIDemoAdmin the owner step reported success, so the apply would fail far from its cause")
	}
	if b.Phase != CLIDemoAuthoring {
		t.Errorf("the project-env beat runs in %q; the listing must exist before the enqueue phase deploys", b.Phase)
	}
}

// TestCLIDemoApplyBeatDoesNotWaitForAnApproval — if the listing did not take, the deploy needs an
// approval nobody will give. --no-wait makes that exit 9 at once instead of waiting out the expiry.
func TestCLIDemoApplyBeatDoesNotWaitForAnApproval(t *testing.T) {
	argv := cliDemoBeatByID(t, "apply").Args(&CLIDemoRun{})
	if !slices.Contains(argv, "--no-wait") {
		t.Errorf("the apply beat %v does not pass --no-wait", argv)
	}
}

// TestCLIDemoFlagCheckProbesTheRerun — the pre-spend flag check reaches every argv a beat runs,
// including the approval rerun, which would otherwise first parse after the approval was given.
func TestCLIDemoFlagCheckProbesTheRerun(t *testing.T) {
	got := cliDemoBeatInvocations(cliDemoBeatByID(t, "destroy"), &CLIDemoRun{})
	if len(got) != 2 || !slices.Contains(got[1], "--wait") {
		t.Errorf("the destroy beat's invocations are %v, want its first run and its --wait rerun", got)
	}
	if got := cliDemoBeatInvocations(cliDemoBeatByID(t, "whoami"), &CLIDemoRun{}); len(got) != 1 {
		t.Errorf("an ordinary beat has %d invocations, want 1", len(got))
	}
}

// TestCLIDemoApprovalBeatShapeIsValidated — an Approval with no Rerun gives the approval and queues
// nothing; the validator refuses it rather than letting the destroy silently not happen.
func TestCLIDemoApprovalBeatShapeIsValidated(t *testing.T) {
	saved := CLIDemoBeats
	t.Cleanup(func() { CLIDemoBeats = saved })
	CLIDemoBeats = slices.Clone(saved)
	for i := range CLIDemoBeats {
		if CLIDemoBeats[i].StepID == "destroy" {
			a := *CLIDemoBeats[i].Approval
			a.Rerun = nil
			CLIDemoBeats[i].Approval = &a
		}
	}
	err := ValidateCLIDemoBeats()
	if err == nil || !strings.Contains(err.Error(), "Approval with no Rerun") {
		t.Errorf("ValidateCLIDemoBeats() = %v, want it to refuse an Approval with no Rerun", err)
	}
}

// TestCLIDemoScriptAdminRunsTheOwnerScript pins the argv the harness hands pnpm: the owner script,
// the seed step's credentials file, and the subcommand's own inputs, from the repository root.
func TestCLIDemoScriptAdminRunsTheOwnerScript(t *testing.T) {
	var dirs []string
	var calls [][]string
	a := cliDemoScriptAdmin{root: "/repo", creds: "/tmp/creds.json",
		exec: func(_ context.Context, dir string, argv []string) ([]byte, error) {
			dirs = append(dirs, dir)
			calls = append(calls, argv)
			return nil, nil
		}}
	if err := a.AutoApproveEnvironment(context.Background(), "p-1", "env-1"); err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(context.Background(), testApprovalID, "env-1"); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"-F", "console", "exec", "tsx", "scripts/cli-demo-approval.mts", "auto-approve", "--creds", "/tmp/creds.json", "--project", "p-1", "--env", "env-1"},
		{"-F", "console", "exec", "tsx", "scripts/cli-demo-approval.mts", "approve", "--creds", "/tmp/creds.json", "--approval", testApprovalID, "--confirm-env", "env-1"},
	}
	if len(calls) != len(want) {
		t.Fatalf("got %d call(s), want %d", len(calls), len(want))
	}
	for i := range want {
		if !slices.Equal(calls[i], want[i]) {
			t.Errorf("call %d = %v, want %v", i, calls[i], want[i])
		}
		if dirs[i] != "/repo" {
			t.Errorf("call %d ran in %q, want the repository root", i, dirs[i])
		}
	}

	a.exec = func(context.Context, string, []string) ([]byte, error) {
		return []byte("cli-demo-approval failed [self_approval]: …"), errors.New("exit status 1")
	}
	if err := a.Approve(context.Background(), testApprovalID, "env-1"); err == nil || !strings.Contains(err.Error(), "self_approval") {
		t.Errorf("err = %v, want the script's own refusal in it", err)
	}
}

// TestCLIDemoScriptAdminRefusesBeforeSpend — a run that could not take the owner steps is refused
// when the run is resolved, before a cluster is bought, naming what is missing.
func TestCLIDemoScriptAdminRefusesBeforeSpend(t *testing.T) {
	none := func(string) string { return "" }
	if _, err := newCLIDemoScriptAdmin("", none); err == nil || !strings.Contains(err.Error(), cliDemoCredsEnv) {
		t.Errorf("no creds file: err = %v, want it to name %s", err, cliDemoCredsEnv)
	}
	_, err := newCLIDemoScriptAdmin("/tmp/creds.json", none)
	if err == nil || !strings.Contains(err.Error(), "ALETHIA_DATABASE_URL") || !strings.Contains(err.Error(), "ALETHIA_APP_DATABASE_URL") {
		t.Errorf("no database: err = %v, want it to name both database variables", err)
	}
}
