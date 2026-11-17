// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The first-run family: `up`, `init`, `version`, `update`, `open`.
//
// What is under test throughout is the contract a first run is judged by: stdout carries the
// result and nothing else, every refusal leaves on stderr with the exit code its class owns and a
// next step, and `up` never queues a deploy that nothing would claim.

// ── helpers ───────────────────────────────────────────────────────────────────────────────

// firstRunPrinter returns a Printer over two buffers, in the given format.
func firstRunPrinter(format string) (*Printer, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	return &Printer{Out: &out, Err: &errOut, Format: format, Mode: Mode{Color: true}}, &out, &errOut
}

// firstRunQuiet returns a Printer whose output nobody reads.
func firstRunQuiet(format string) *Printer {
	p, _, _ := firstRunPrinter(format)
	return p
}

// firstRunSaid is everything a refusal tells its reader: the message and the hint.
func firstRunSaid(err error) string {
	e := clierr.From(err)
	return e.Message + "\n" + e.Hint
}

// firstRunExec runs the CLI under h and returns the exit code of the fatal path it took (-1 for
// none) with what it wrote on each stream.
func firstRunExec(t *testing.T, h projHarness, args ...string) (int, string, string) {
	t.Helper()
	code := -1
	prev := exitFunc
	exitFunc = func(c int) {
		code = c
		panic(projExit{c})
	}
	defer func() { exitFunc = prev }()

	readOut := projCaptureStdout(t)
	_, readErr := captureStderr(t)
	h.run(args...)
	return code, readOut(), readErr()
}

// firstRunEnvelope decodes the one alethia.error/v1 object a json refusal leaves on stderr.
func firstRunEnvelope(t *testing.T, stderr string) map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	var doc struct {
		Error  map[string]any `json:"error"`
		Schema string         `json:"schema"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &doc); err != nil {
		t.Fatalf("the last stderr line is not an error envelope: %v\n%s", err, stderr)
	}
	if doc.Schema != clierr.Schema {
		t.Fatalf("schema = %q, want %q", doc.Schema, clierr.Schema)
	}
	return doc.Error
}

// firstRunManifest writes the demo manifest into a fresh working directory.
func firstRunManifest(t *testing.T) {
	t.Helper()
	dir := chdirTo(t)
	if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(applyDemoManifest), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeRunners is the runner step's view of a control plane.
type fakeRunners struct {
	list    []api.Runner
	err     error
	pools   []api.FleetPool
	poolErr error
}

// GetRunners returns the configured list.
func (f *fakeRunners) GetRunners() ([]api.Runner, error) { return f.list, f.err }

// ListFleetPools returns the configured pools.
func (f *fakeRunners) ListFleetPools() ([]api.FleetPool, error) { return f.pools, f.poolErr }

// firstRunSelfHosted points the CLI at a control plane that is not the hosted one, which is where
// the runner list is the whole truth.
func firstRunSelfHosted(t *testing.T) {
	t.Helper()
	isolatedHome(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://alethia.internal.example.com")
}

// firstRunHintCommand returns the command a hint opens with: everything before the first run of
// three spaces, which is how a hint separates the command from the sentence after it.
func firstRunHintCommand(hint string) []string {
	command, _, _ := strings.Cut(hint, "   ")
	return strings.Fields(command)
}

// ── up: the runner step ───────────────────────────────────────────────────────────────────

// With nothing able to claim the deploy, `up` stops with exit 7 and a command that exists in this
// CLI and is valid for the account's cloud. One row per offered cloud, so a cloud added to the
// catalog joins the test by being added.
func TestFirstRun_NoRunnerNamesACommandValidForEachCloud(t *testing.T) {
	firstRunSelfHosted(t)
	clouds := EnabledCloudProviders()
	if len(clouds) == 0 {
		t.Fatal("no cloud is offered, so nothing below would be asserted")
	}
	for _, cloud := range clouds {
		for _, tc := range []struct {
			name string
			list []api.Runner
		}{
			{"no runner at all", nil},
			{"only an offline runner", []api.Runner{{ID: "r1", Name: "old", Status: "OFFLINE"}}},
			{"an online runner for another cloud", []api.Runner{{
				ID: "r2", Name: "elsewhere", Status: runnerStatusOnline, SupportedProviders: []string{"not-" + string(cloud)},
			}}},
		} {
			t.Run(string(cloud)+"/"+tc.name, func(t *testing.T) {
				account := api.CloudIdentity{ID: "ci1", Provider: string(cloud), Label: "prod-account"}
				ref, err := ensureRunner(&fakeRunners{list: tc.list, poolErr: errBoom}, firstRunQuiet(ui.FormatTable), "", account)
				if err == nil {
					t.Fatalf("a deploy nothing would claim was let through with runner %q", ref)
				}
				e := clierr.From(err)
				if e.Exit != clierr.ExitConflict {
					t.Errorf("exit = %d, want %d (a failed precondition)", e.Exit, clierr.ExitConflict)
				}
				if !strings.Contains(e.Message, string(cloud)) {
					t.Errorf("the refusal does not name the cloud it looked for a runner for:\n%s", e.Message)
				}

				// The hint is a command, and the command is real: it resolves in the live tree.
				tokens := firstRunHintCommand(e.Hint)
				if len(tokens) < 3 || tokens[0] != "alethia" {
					t.Fatalf("the hint does not open with an alethia command: %q", e.Hint)
				}
				found, _, findErr := rootCmd.Find(tokens[1:3])
				if findErr != nil || found.CommandPath() != strings.Join(tokens[:3], " ") {
					t.Fatalf("the hint names %q, which is not a command of this CLI (%v)", strings.Join(tokens[:3], " "), findErr)
				}
				// And it is valid for THIS cloud: `runner deploy` only where a runner can be built,
				// and only when something is online to build it.
				if found == runnerDeployCmd {
					online := len(tc.list) > 0 && tc.list[0].Status == runnerStatusOnline
					if !runners.IsDeployProvider(string(cloud)) || !online {
						t.Errorf("`runner deploy` was offered for %s with online=%v", cloud, online)
					}
				} else if found != runnerRegisterCmd {
					t.Errorf("the hint names %q, which adds no runner", found.CommandPath())
				}
			})
		}
	}
}

// `runner deploy` is the answer exactly where it can work: a cloud with a runner template, and a
// runner already online to run the build.
func TestFirstRun_RunnerCommandFor(t *testing.T) {
	deployable := runners.DeployProviders()
	if len(deployable) == 0 {
		t.Fatal("no cloud has a runner template, so the deploy arm cannot be reached")
	}
	account := api.CloudIdentity{Provider: deployable[0], Label: "prod account"}
	if got := runnerCommandFor(account, true); got != `alethia runner deploy --cloud-account "prod account"` {
		t.Errorf("with a runner online: %q", got)
	}
	if got := runnerCommandFor(account, false); got != "alethia runner register "+deployable[0]+"-runner" {
		t.Errorf("with nothing online: %q", got)
	}
	if got := runnerCommandFor(api.CloudIdentity{}, false); got != "alethia runner register first-runner" {
		t.Errorf("with no account decided: %q", got)
	}
}

func TestFirstRun_EnsureRunnerSaysWhatWillClaimTheDeploy(t *testing.T) {
	firstRunSelfHosted(t)
	aws := api.CloudIdentity{ID: "ci1", Provider: "aws", Label: "prod-account"}
	primary := api.Runner{ID: "r1", Name: "primary", Operator: "managed", Status: runnerStatusOnline}
	edge := api.Runner{ID: "r2", Name: "edge", Operator: "self", Status: runnerStatusOnline, SupportedProviders: []string{"aws"}}
	gcpOnly := api.Runner{ID: "r3", Name: "gcp-only", Operator: "self", Status: runnerStatusOnline, SupportedProviders: []string{"gcp"}}
	draining := api.Runner{ID: "r4", Name: "draining", Operator: "self", Status: "DRAINING"}

	for _, tc := range []struct {
		name    string
		src     *fakeRunners
		ref     string
		wantRef string
		wantSay string
	}{
		{"the only usable runner is named and used", &fakeRunners{list: []api.Runner{primary, gcpOnly, draining}}, "", "r1", "Runner primary (managed)"},
		{"several usable runners are counted and none is chosen", &fakeRunners{list: []api.Runner{primary, edge}}, "", "", "2 runners are online"},
		{"a runner named by name", &fakeRunners{list: []api.Runner{primary, edge}}, "edge", "r2", "Runner edge (yours)"},
		{"a runner named by id", &fakeRunners{list: []api.Runner{primary, edge}}, "r1", "r1", "Runner primary (managed)"},
		{"an enabled pool starts a runner", &fakeRunners{pools: []api.FleetPool{{Provider: "hcloud", Enabled: true, Max: 2}}}, "", "", "managed fleet"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, out, errOut := firstRunPrinter(ui.FormatJSON)
			ref, err := ensureRunner(tc.src, p, tc.ref, aws)
			if err != nil {
				t.Fatalf("ensureRunner: %v", err)
			}
			if ref != tc.wantRef {
				t.Errorf("runner = %q, want %q", ref, tc.wantRef)
			}
			if !strings.Contains(errOut.String(), tc.wantSay) {
				t.Errorf("stderr does not say %q:\n%s", tc.wantSay, errOut.String())
			}
			if out.Len() != 0 {
				t.Errorf("the step wrote on stdout: %q", out.String())
			}
		})
	}

	for _, tc := range []struct {
		name     string
		src      *fakeRunners
		ref      string
		wantExit int
		wantSay  string
	}{
		{"a named runner that is not online", &fakeRunners{list: []api.Runner{primary, draining}}, "draining", clierr.ExitConflict, "DRAINING"},
		{"a named runner that does not take this cloud", &fakeRunners{list: []api.Runner{primary, gcpOnly}}, "gcp-only", clierr.ExitConflict, "does not take aws jobs"},
		{"a named runner that does not exist", &fakeRunners{list: []api.Runner{primary}}, "nope", clierr.ExitNotFound, "nope"},
		{"a disabled pool is not a fleet", &fakeRunners{pools: []api.FleetPool{{Provider: "hcloud", Enabled: false, Max: 2}}}, "", clierr.ExitConflict, "nothing would claim"},
		{"an empty pool is not a fleet", &fakeRunners{pools: []api.FleetPool{{Provider: "hcloud", Enabled: true}}}, "", clierr.ExitConflict, "nothing would claim"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ensureRunner(tc.src, firstRunQuiet(ui.FormatTable), tc.ref, aws)
			if err == nil {
				t.Fatal("expected a refusal")
			}
			e := clierr.From(err)
			if e.Exit != tc.wantExit {
				t.Errorf("exit = %d, want %d", e.Exit, tc.wantExit)
			}
			if !strings.Contains(e.Message, tc.wantSay) {
				t.Errorf("the refusal does not say %q:\n%s", tc.wantSay, e.Message)
			}
			if e.Hint == "" {
				t.Error("the refusal carries no next step")
			}
		})
	}

	// A list that could not be read is reported as that, never as "no runners".
	if _, err := ensureRunner(&fakeRunners{err: errBoom}, firstRunQuiet(ui.FormatTable), "", aws); !errors.Is(err, errBoom) {
		t.Errorf("a failed runner listing was not carried: %v", err)
	}
}

// On the hosted control plane an empty runner list is the ordinary case: the managed fleet claims
// the unassigned deploy, and `up` says so rather than refusing.
func TestFirstRun_HostedControlPlaneLeavesTheDeployToTheManagedFleet(t *testing.T) {
	isolatedHome(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", types.DefaultWebOrigin)
	p, _, errOut := firstRunPrinter(ui.FormatTable)
	ref, err := ensureRunner(&fakeRunners{poolErr: errBoom}, p, "", api.CloudIdentity{Provider: "hetzner", Label: "h"})
	if err != nil {
		t.Fatalf("the hosted control plane refused a deploy its fleet would take: %v", err)
	}
	if ref != "" {
		t.Errorf("the deploy was assigned to %q; it must be left for the fleet", ref)
	}
	if !strings.Contains(errOut.String(), "managed fleet") {
		t.Errorf("it did not say what takes the deploy:\n%s", errOut.String())
	}
}

func TestFirstRun_HostedControlPlane(t *testing.T) {
	for origin, want := range map[string]bool{
		types.DefaultWebOrigin:                 true,
		"https://ALETHIALABS.io/":              true,
		"https://staging.alethialabs.io":       true,
		"https://alethialabs.io.example.com":   false,
		"https://notalethialabs.io":            false,
		"https://alethia.internal.example.com": false,
		"http://localhost:3000":                false,
		"://not a url":                         false,
	} {
		if got := hostedControlPlane(origin); got != want {
			t.Errorf("hostedControlPlane(%q) = %v, want %v", origin, got, want)
		}
	}
}

// The audit's case, end to end: `up --no-input --yes` against a control plane with no runner.
// It must stop before anything is created, on stderr, with exit 7 — not queue a deploy and wait.
func TestFirstRun_UpWithNoRunnerStopsBeforeAnythingIsCreated(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), runners: []map[string]any{}}
	h := upEnv(t, s)
	firstRunManifest(t)

	code, stdout, stderr := firstRunExec(t, h, "up", "--no-input", "--yes")
	if code != clierr.ExitConflict {
		t.Fatalf("exit = %d, want %d\nstderr:\n%s", code, clierr.ExitConflict, stderr)
	}
	if stdout != "" {
		t.Errorf("a refusal wrote on stdout: %q", stdout)
	}
	for _, want := range []string{"nothing would claim this deploy", "hint", "alethia runner register"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr does not carry %q:\n%s", want, stderr)
		}
	}
	if len(s.posts) != 0 {
		t.Errorf("it wrote to the control plane before refusing: %+v", s.posts)
	}

	// The same refusal for a program: one envelope on stderr, and still nothing on stdout.
	code, stdout, stderr = firstRunExec(t, h, "up", "--no-input", "--yes", "--output", "json")
	if code != clierr.ExitConflict || stdout != "" {
		t.Fatalf("json: exit = %d, stdout = %q", code, stdout)
	}
	envelope := firstRunEnvelope(t, stderr)
	if envelope["class"] != string(clierr.ClassConflict) || envelope["hint"] == nil {
		t.Errorf("envelope: %+v", envelope)
	}
}

// With a manifest that names its account, the runner step runs BEFORE any question is asked: a
// run that cannot deploy must not author a file first.
func TestFirstRun_UpChecksTheRunnerBeforeAuthoringWhenTheAccountIsKnown(t *testing.T) {
	s := &projServer{runners: []map[string]any{}}
	h := upEnv(t, s)
	chdirTo(t)
	code, _, _ := firstRunExec(t, h, "up", "--no-input", "--yes",
		"--project", "boutique", "--region", "eu-west-1", "--cloud-account", "prod-account")
	if code != clierr.ExitConflict {
		t.Fatalf("exit = %d, want %d", code, clierr.ExitConflict)
	}
	if manifest.Exists(manifest.FileName) {
		t.Error("a manifest was authored for a run that could never deploy")
	}
}

// With two accounts and none named, the account is decided by the file, so the runner step runs
// after it.
func TestFirstRun_UpChecksTheRunnerAfterTheFileDecidesTheAccount(t *testing.T) {
	identities := []api.CloudIdentity{
		{ID: "ci1", Provider: "aws", Label: "prod-account"},
		{ID: "ci2", Provider: "gcp", Label: "other"},
	}
	chdirTo(t)
	if _, known := upTargetAccount(identities, manifest.FileName, ""); known {
		t.Error("two accounts and no manifest: nothing has decided the account yet")
	}
	if got, known := upTargetAccount(identities, manifest.FileName, "other"); !known || got.Provider != "gcp" {
		t.Errorf("--cloud-account decides it: %+v %v", got, known)
	}
	if _, known := upTargetAccount(identities, manifest.FileName, "nope"); known {
		t.Error("a reference that matches nothing decides nothing")
	}
	if got, known := upTargetAccount(identities[:1], manifest.FileName, ""); !known || got.ID != "ci1" {
		t.Errorf("one account is the account: %+v %v", got, known)
	}

	// An existing manifest outranks the flag: it is what the apply reads.
	if err := os.WriteFile(manifest.FileName, []byte(applyDemoManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, known := upTargetAccount(identities, manifest.FileName, "other"); !known || got.Label != "prod-account" {
		t.Errorf("the manifest's account: %+v %v", got, known)
	}
	// A file that cannot be read decides nothing here; the apply reports why.
	if err := os.WriteFile(manifest.FileName, []byte("project: [unclosed"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, known := upTargetAccount(identities, manifest.FileName, ""); known {
		t.Error("an unreadable manifest decided an account")
	}
}

// ── up: the wait ──────────────────────────────────────────────────────────────────────────

// scriptedJobs answers GetJob with one status per poll, repeating the last.
type scriptedJobs struct {
	applyClient
	statuses []string
	polls    int
	err      error
}

// GetJob returns the next scripted status.
func (s *scriptedJobs) GetJob(jobID string) (*api.ProvisionJob, error) {
	if s.err != nil {
		return nil, s.err
	}
	i := s.polls
	if i >= len(s.statuses) {
		i = len(s.statuses) - 1
	}
	s.polls++
	return &api.ProvisionJob{ID: jobID, JobType: "DEPLOY", Status: s.statuses[i]}, nil
}

// firstRunFastPoll shortens the poll interval for one test.
func firstRunFastPoll(t *testing.T) {
	t.Helper()
	prev := jobPollInterval
	jobPollInterval = time.Millisecond
	t.Cleanup(func() { jobPollInterval = prev })
}

// A job held for an approval is WAITING, not hung and not failed: the wait keeps polling through
// it for as long as it takes, says once what the person has to do, and ends when the job does.
func TestFirstRun_AJobAwaitingApprovalIsWaitedThrough(t *testing.T) {
	firstRunFastPoll(t)
	firstRunSelfHosted(t)
	p, out, errOut := firstRunPrinter(ui.FormatJSON)
	jobs := &scriptedJobs{statuses: []string{
		"QUEUED", jobStatusAwaitingApproval, jobStatusAwaitingApproval, jobStatusAwaitingApproval, "PROCESSING", "SUCCESS",
	}}
	job, err := awaitJob(context.Background(), newDeployWatcher(jobs, p), "j1", waitOptions{})
	if err != nil {
		t.Fatalf("a job that was approved and then succeeded was reported as %v", err)
	}
	if job.Status != jobStatusSuccess || jobs.polls != 6 {
		t.Errorf("status %s after %d polls", job.Status, jobs.polls)
	}
	said := errOut.String()
	if strings.Count(said, "waiting for approval") != 1 {
		t.Errorf("the approval line must be said exactly once:\n%s", said)
	}
	for _, want := range []string{"j1", WebOrigin(), "continues by itself"} {
		if !strings.Contains(said, want) {
			t.Errorf("the approval line does not carry %q:\n%s", want, said)
		}
	}
	if out.Len() != 0 {
		t.Errorf("the wait wrote on stdout: %q", out.String())
	}
}

// A deadline that passes while the job is held is a wait timeout — exit 12, the job named so the
// wait can be resumed — and never an operation failure.
func TestFirstRun_ATimeoutWhileAwaitingApprovalIsResumable(t *testing.T) {
	firstRunFastPoll(t)
	jobs := &scriptedJobs{statuses: []string{jobStatusAwaitingApproval}}
	_, err := awaitJob(context.Background(), newDeployWatcher(jobs, firstRunQuiet(ui.FormatTable)), "j1",
		waitOptions{Timeout: 20 * time.Millisecond})
	e := clierr.From(err)
	if e.Exit != clierr.ExitWaitTimeout {
		t.Fatalf("exit = %d, want %d: %v", e.Exit, clierr.ExitWaitTimeout, err)
	}
	if e.Operation == nil || e.Operation.ID != "j1" {
		t.Errorf("the timeout does not name the job to resume: %+v", e.Operation)
	}
}

// A deploy nobody claims says so once the threshold passes, once, with what to look at.
func TestFirstRun_AQueuedJobNobodyClaimsIsCalledOut(t *testing.T) {
	prev := queuedNoticeAfter
	queuedNoticeAfter = time.Minute
	t.Cleanup(func() { queuedNoticeAfter = prev })

	p, _, errOut := firstRunPrinter(ui.FormatTable)
	w := newDeployWatcher(&scriptedJobs{statuses: []string{"QUEUED"}}, p)
	clock := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	w.now = func() time.Time { return clock }

	for _, step := range []time.Duration{0, 30 * time.Second, 29 * time.Second} {
		clock = clock.Add(step)
		if _, err := w.GetJob("j1"); err != nil {
			t.Fatal(err)
		}
	}
	if errOut.Len() != 0 {
		t.Fatalf("it spoke before the threshold:\n%s", errOut.String())
	}
	for range 3 {
		clock = clock.Add(time.Second)
		if _, err := w.GetJob("j1"); err != nil {
			t.Fatal(err)
		}
	}
	said := errOut.String()
	if strings.Count(said, "no runner has claimed it") != 1 {
		t.Errorf("the notice must be said exactly once:\n%s", said)
	}
	for _, want := range []string{"alethia runner list", "alethia jobs logs j1 --follow"} {
		if !strings.Contains(said, want) {
			t.Errorf("the notice does not carry %q:\n%s", want, said)
		}
	}

	// A poll that fails is carried as it is, and says nothing.
	failing := newDeployWatcher(&scriptedJobs{err: errBoom}, p)
	if _, err := failing.GetJob("j2"); !errors.Is(err, errBoom) {
		t.Errorf("a failed poll was not carried: %v", err)
	}
}

// The whole command, waiting: a deploy held for approval and then run to success ends as a
// success, with the approval line on stderr.
func TestFirstRun_UpWaitsThroughAnApproval(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), jobStatuses: []string{
		jobStatusAwaitingApproval, jobStatusAwaitingApproval, "SUCCESS",
	}}
	h := upEnv(t, s)
	firstRunManifest(t)

	code, stdout, stderr := firstRunExec(t, h, "up", "--no-input", "--yes", "--output", "json")
	if code != -1 {
		t.Fatalf("up exited %d\nstderr:\n%s", code, stderr)
	}
	if !strings.Contains(stderr, "waiting for approval") {
		t.Errorf("stderr does not say the deploy is waiting for approval:\n%s", stderr)
	}
	var result ApplyResult
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("stdout is not the one result document: %v\n%s", err, stdout)
	}
	if len(result.Jobs) == 0 || result.Jobs[0].Status != jobStatusSuccess {
		t.Errorf("jobs: %+v", result.Jobs)
	}
}

// A deploy that fails is exit 13 with the job named, on stderr.
func TestFirstRun_UpExitsThirteenWhenTheDeployFails(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), jobStatuses: []string{"PROCESSING", "FAILED"}, jobErrMsg: "quota exceeded"}
	h := upEnv(t, s)
	firstRunManifest(t)
	code, _, stderr := firstRunExec(t, h, "up", "--no-input", "--yes", "--output", "json")
	if code != clierr.ExitOperationFailed {
		t.Fatalf("exit = %d, want %d\n%s", code, clierr.ExitOperationFailed, stderr)
	}
	envelope := firstRunEnvelope(t, stderr)
	if envelope["operation"] == nil || !strings.Contains(envelope["message"].(string), "quota exceeded") {
		t.Errorf("envelope: %+v", envelope)
	}
}

// ── up: streams ───────────────────────────────────────────────────────────────────────────

// Every step `up` narrates is on stderr, in every format; stdout is the apply's alone.
func TestFirstRun_UpNarratesOnStderr(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := upEnv(t, s)
	firstRunManifest(t)
	code, stdout, stderr := firstRunExec(t, h, "up", "--yes", "--no-wait", "--no-input")
	if code != -1 {
		t.Fatalf("up exited %d\n%s", code, stderr)
	}
	for _, step := range []string{"Already signed in", "1 cloud account connected", "Runner primary (managed) takes the deploy"} {
		if !strings.Contains(stderr, step) {
			t.Errorf("stderr is missing the step %q:\n%s", step, stderr)
		}
		if strings.Contains(stdout, step) {
			t.Errorf("the step %q leaked onto stdout:\n%s", step, stdout)
		}
	}
	// The one usable runner was handed to the apply, so the deploy is assigned rather than left.
	var assigned bool
	for _, post := range s.posts {
		if post.Path == "/api/jobs" && post.Body["assigned_runner_id"] == "r1" {
			assigned = true
		}
	}
	if !assigned {
		t.Errorf("no deploy was assigned to the runner the step named: %+v", s.posts)
	}
}

// ── the refusals `up` and `init` share ────────────────────────────────────────────────────

func TestFirstRun_RefusalsCarryTheirClass(t *testing.T) {
	t.Run("no cloud account is a failed precondition", func(t *testing.T) {
		h := upEnv(t, &projServer{noIdentities: true})
		chdirTo(t)
		for _, command := range []string{"up", "init"} {
			args := []string{command, "--no-input"}
			if command == "up" {
				args = append(args, "--yes")
			}
			code, stdout, stderr := firstRunExec(t, h, args...)
			if code != clierr.ExitConflict || stdout != "" || !strings.Contains(stderr, "alethia connector ") {
				t.Errorf("%s: exit %d, stdout %q, stderr:\n%s", command, code, stdout, stderr)
			}
		}
	})
	t.Run("a value nothing can ask for names its flags", func(t *testing.T) {
		h := upEnv(t, &projServer{})
		chdirTo(t)
		for _, command := range []string{"up", "init"} {
			args := []string{command, "--no-input"}
			if command == "up" {
				args = append(args, "--yes")
			}
			code, stdout, stderr := firstRunExec(t, h, args...)
			if code != clierr.ExitInputRequired || stdout != "" {
				t.Errorf("%s: exit %d, stdout %q", command, code, stdout)
			}
			for _, flag := range []string{"--project", "--region"} {
				if !strings.Contains(stderr, flag) {
					t.Errorf("%s: the refusal does not name %s:\n%s", command, flag, stderr)
				}
			}
		}
	})
	t.Run("an account that does not exist is not found", func(t *testing.T) {
		h := upEnv(t, &projServer{})
		chdirTo(t)
		code, _, stderr := firstRunExec(t, h, "init", "--no-input", "--project", "b", "--region", "r", "--cloud-account", "nope")
		if code != clierr.ExitNotFound || !strings.Contains(stderr, "nope") {
			t.Errorf("exit %d\n%s", code, stderr)
		}
	})
	t.Run("authoring flags against an existing manifest are a usage error", func(t *testing.T) {
		h := upEnv(t, &projServer{envs: applyDemoEnvs()})
		firstRunManifest(t)
		code, _, stderr := firstRunExec(t, h, "up", "--no-input", "--yes", "--project", "other")
		if code != clierr.ExitUsage || !strings.Contains(stderr, "--project") {
			t.Errorf("exit %d\n%s", code, stderr)
		}
	})
	t.Run("no credential is an authentication refusal", func(t *testing.T) {
		h := upEnv(t, &projServer{})
		chdirTo(t)
		if err := os.Remove(h.creds); err != nil {
			t.Fatal(err)
		}
		t.Setenv(ServiceTokenEnv, "")
		for _, args := range [][]string{
			{"up", "--no-input", "--yes"},
			{"up", "--no-input", "--yes", "--output", "json"},
			{"init", "--no-input", "--output", "json"},
		} {
			code, stdout, stderr := firstRunExec(t, h, args...)
			if code != clierr.ExitAuth || stdout != "" || !strings.Contains(stderr, "alethia login") {
				t.Errorf("%v: exit %d, stdout %q\n%s", args, code, stdout, stderr)
			}
		}
	})
}

func TestFirstRun_ErrKeepsAClassAndAddsTheNextStep(t *testing.T) {
	plain := firstRunErr(clierr.CodeNotFound, errBoom, "alethia runner list")
	if e := clierr.From(plain); e.Exit != clierr.ExitNotFound || e.Hint != "alethia runner list" || !errors.Is(plain, errBoom) {
		t.Errorf("an unclassified error: %+v", e)
	}
	// An error that already has a class keeps it, and a shared sentinel is never written to.
	classed := firstRunErr(clierr.CodeNotFound, errConfirmRequiresYes, "pass --yes")
	if e := clierr.From(classed); e.Exit != clierr.ExitInputRequired || e.Hint != "pass --yes" {
		t.Errorf("a classified error: %+v", e)
	}
	if errConfirmRequiresYes.Hint != "" {
		t.Errorf("the shared sentinel was given a hint: %q", errConfirmRequiresYes.Hint)
	}
	// And a hint the error brought with it is the one that stays.
	hinted := clierr.New(clierr.CodeConflict, "busy")
	hinted.Hint = "wait"
	if e := clierr.From(firstRunErr(clierr.CodeNotFound, hinted, "other")); e.Hint != "wait" {
		t.Errorf("hint = %q", e.Hint)
	}
}

// ── init ──────────────────────────────────────────────────────────────────────────────────

// initResultDoc is `init -o json` as a caller decodes it.
type initResultDoc struct {
	ID     string     `json:"id"`
	Kind   string     `json:"kind"`
	Action string     `json:"action"`
	Job    *JobRef    `json:"job"`
	DryRun bool       `json:"dry_run"`
	Object InitObject `json:"object"`
}

func TestFirstRun_InitJSONIsOneMutationResult(t *testing.T) {
	h := upEnv(t, &projServer{})
	chdirTo(t)

	decode := func(args ...string) initResultDoc {
		t.Helper()
		code, stdout, stderr := firstRunExec(t, h, append(args, "--no-input", "--output", "json")...)
		if code != -1 {
			t.Fatalf("%v exited %d\n%s", args, code, stderr)
		}
		var doc initResultDoc
		dec := json.NewDecoder(strings.NewReader(stdout))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&doc); err != nil {
			t.Fatalf("%v: stdout is not one mutation result: %v\n%s", args, err, stdout)
		}
		if dec.More() {
			t.Fatalf("%v: stdout carries more than the result:\n%s", args, stdout)
		}
		return doc
	}

	created := decode("init", "--web-origin", WebOrigin(), "--project", "boutique", "--region", "eu-west-1", "--cloud-account", "prod-account")
	if created.Kind != initKindManifest || created.Action != string(ResultCreated) || created.ID != manifest.FileName {
		t.Errorf("created: %+v", created)
	}
	if o := created.Object; o.Project != "boutique" || o.Region != "eu-west-1" || o.CloudAccount != "prod-account" ||
		o.WebOrigin != WebOrigin() || len(o.Environments) != 1 || o.Addons == nil {
		t.Errorf("object: %+v", o)
	}

	// Run again: the file is there, and the result says nothing changed.
	again := decode("init", "--web-origin", WebOrigin())
	if again.Action != string(ResultUnchanged) || again.Object.Manifest != manifest.FileName {
		t.Errorf("again: %+v", again)
	}

	only := decode("init", "--web-origin", WebOrigin(), "--skip-manifest")
	if only.Kind != initKindConfig || only.ID != WebOrigin() || only.Object.Manifest != "" {
		t.Errorf("--skip-manifest: %+v", only)
	}
}

// For a person: the result is one line on stdout, and everything else — the steps, the next
// command — is on stderr.
func TestFirstRun_InitForAPerson(t *testing.T) {
	h := upEnv(t, &projServer{})
	chdirTo(t)
	code, stdout, stderr := firstRunExec(t, h, "init", "--web-origin", WebOrigin(),
		"--project", "boutique", "--region", "eu-west-1", "--cloud-account", "prod-account", "--no-input")
	if code != -1 {
		t.Fatalf("init exited %d\n%s", code, stderr)
	}
	if strings.TrimSpace(stdout) != ui.FormatSuccess("Wrote "+manifest.FileName) {
		t.Errorf("stdout = %q, want the one result line", stdout)
	}
	for _, want := range []string{"Already signed in", "alethia apply", "alethia up"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr does not carry %q:\n%s", want, stderr)
		}
	}
	var buf bytes.Buffer
	renderInitResult(&buf, MutationResult{ID: "https://x", Kind: initKindConfig})
	if !strings.Contains(buf.String(), "set up for https://x") {
		t.Errorf("the machine-setup line: %q", buf.String())
	}
}

func TestFirstRun_InitRefusesABadOriginAndABadAddon(t *testing.T) {
	h := upEnv(t, &projServer{})
	chdirTo(t)
	code, stdout, stderr := firstRunExec(t, h, "init", "--no-input", "--web-origin", "not a url")
	if code != clierr.ExitUsage || stdout != "" || !strings.Contains(stderr, "hint") {
		t.Errorf("a bad origin: exit %d, stdout %q\n%s", code, stdout, stderr)
	}
	code, _, _ = firstRunExec(t, h, "init", "--no-input", "--web-origin", WebOrigin(),
		"--project", "b", "--region", "r", "--cloud-account", "prod-account", "--addon", "loki@")
	if code != clierr.ExitUsage {
		t.Errorf("a bad --addon: exit %d, want %d", code, clierr.ExitUsage)
	}
	if manifest.Exists(manifest.FileName) {
		t.Error("a manifest was written after a refused flag")
	}
}

// ── version ───────────────────────────────────────────────────────────────────────────────

// firstRunBuild stamps a release and a build the test binary does not carry.
func firstRunBuild(t *testing.T, release string, settings ...debug.BuildSetting) {
	t.Helper()
	prevVersion, prevRead := version.Version, readBuildInfo
	version.Version = release
	readBuildInfo = func() (*debug.BuildInfo, bool) {
		return &debug.BuildInfo{Settings: settings}, len(settings) > 0
	}
	t.Cleanup(func() { version.Version, readBuildInfo = prevVersion, prevRead })
}

func TestFirstRun_VersionJSONCarriesVersionCommitAndDate(t *testing.T) {
	h := upEnv(t, &projServer{})
	firstRunBuild(t, "1.4.2",
		debug.BuildSetting{Key: "vcs.revision", Value: "0123456789abcdef0123456789abcdef01234567"},
		debug.BuildSetting{Key: "vcs.time", Value: "2026-11-17T09:30:00Z"},
		debug.BuildSetting{Key: "vcs.modified", Value: "false"})

	code, stdout, stderr := firstRunExec(t, h, "version", "--output", "json")
	if code != -1 {
		t.Fatalf("version exited %d\n%s", code, stderr)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("stdout is not json: %v\n%s", err, stdout)
	}
	for key, want := range map[string]any{
		"version": "1.4.2",
		"commit":  "0123456789abcdef0123456789abcdef01234567",
		"date":    "2026-11-17T09:30:00Z",
	} {
		if doc[key] != want {
			t.Errorf("%s = %v, want %v", key, doc[key], want)
		}
	}
	for _, key := range versionColumns {
		if _, ok := doc[key]; !ok {
			t.Errorf("the document has no %q key: %s", key, stdout)
		}
	}

	// For a person, line one is the release and nothing else: `alethia update` reads it back.
	_, stdout, _ = firstRunExec(t, h, "version", "--output", "table")
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if lines[0] != "alethia v1.4.2" || len(lines) != 2 || !strings.Contains(lines[1], "commit 0123456789ab ") {
		t.Errorf("table form:\n%s", stdout)
	}

	_, stdout, _ = firstRunExec(t, h, "version", "--output", "csv")
	if !strings.HasPrefix(stdout, strings.Join(versionColumns, ",")) || !strings.Contains(stdout, "1.4.2") {
		t.Errorf("csv form:\n%s", stdout)
	}
}

// A binary with no build facts says "unknown" rather than leaving the keys out.
func TestFirstRun_VersionWithoutBuildFacts(t *testing.T) {
	firstRunBuild(t, "dev")
	info := buildVersionInfo()
	if info.Commit != buildUnknown || info.Date != buildUnknown || info.Version != "dev" || info.Go == "" {
		t.Errorf("%+v", info)
	}
}

func TestFirstRun_VersionReportsANewerRelease(t *testing.T) {
	isolatedHome(t)
	release := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"2.0.0"}`))
	}))
	t.Cleanup(release.Close)

	t.Setenv(noUpdateCheckEnv, "")
	if got := latestRelease("1.0.0", release.URL); got != "2.0.0" {
		t.Errorf("latest = %q, want the control plane's answer", got)
	}
	// Unreachable, and nothing cached: no answer, and no failure.
	if got := latestRelease("1.0.0", "http://127.0.0.1:1"); got != "" {
		t.Errorf("latest = %q with the control plane unreachable and no cache", got)
	}
	// A development build and a silenced check look nothing up.
	if got := latestRelease("dev", release.URL); got != "" {
		t.Errorf("a development build looked up %q", got)
	}
	t.Setenv(noUpdateCheckEnv, "1")
	if got := latestRelease("1.0.0", release.URL); got != "" {
		t.Errorf("a silenced check looked up %q", got)
	}

	// The command says so on stderr, and the document carries it. The harness silences the
	// check, so it is switched back on after the harness is built.
	h := upEnv(t, &projServer{})
	t.Setenv(noUpdateCheckEnv, "")
	t.Setenv("ALETHIA_WEB_ORIGIN", release.URL)
	firstRunBuild(t, "1.0.0")
	_, stdout, stderr := firstRunExec(t, h, "version", "--output", "json")
	if !strings.Contains(stdout, `"update_available": true`) && !strings.Contains(stdout, `"update_available":true`) {
		t.Errorf("the document does not report the newer release:\n%s", stdout)
	}
	if !strings.Contains(stderr, "alethia update") {
		t.Errorf("stderr does not name the command that installs it:\n%s", stderr)
	}
}

// ── update ────────────────────────────────────────────────────────────────────────────────

// firstRunRelease serves one release document.
func firstRunRelease(t *testing.T, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestFirstRun_UpdateRefusesADevelopmentBuildOnStderr(t *testing.T) {
	h := upEnv(t, &projServer{})
	firstRunBuild(t, "dev")
	code, stdout, stderr := firstRunExec(t, h, "update", "--output", "json")
	if code != clierr.ExitConflict || stdout != "" {
		t.Fatalf("exit %d, stdout %q\n%s", code, stdout, stderr)
	}
	if envelope := firstRunEnvelope(t, stderr); envelope["hint"] == nil {
		t.Errorf("the refusal carries no next step: %+v", envelope)
	}
}

func TestFirstRun_UpdateJSONIsOneMutationResult(t *testing.T) {
	h := upEnv(t, &projServer{})
	t.Setenv("ALETHIA_WEB_ORIGIN", firstRunRelease(t, `{"version":"2.0.0"}`))
	firstRunBuild(t, "2.0.0")

	code, stdout, stderr := firstRunExec(t, h, "update", "--output", "json")
	if code != -1 {
		t.Fatalf("update exited %d\n%s", code, stderr)
	}
	var doc struct {
		ID     string  `json:"id"`
		Kind   string  `json:"kind"`
		Action string  `json:"action"`
		Job    *JobRef `json:"job"`
		DryRun bool    `json:"dry_run"`
		Object struct {
			From            string `json:"from"`
			To              string `json:"to"`
			Method          string `json:"method"`
			Updated         bool   `json:"updated"`
			Deferred        bool   `json:"deferred"`
			UpdateAvailable bool   `json:"update_available"`
		} `json:"object"`
	}
	dec := json.NewDecoder(strings.NewReader(stdout))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("stdout is not one mutation result: %v\n%s", err, stdout)
	}
	if doc.ID != "alethia" || doc.Kind != "cli" || doc.Action != string(ResultUnchanged) || doc.DryRun ||
		doc.Object.From != "2.0.0" || doc.Object.To != "2.0.0" || doc.Object.UpdateAvailable || doc.Object.Updated {
		t.Errorf("%+v", doc)
	}

	// For a person the same run is one sentence on stdout.
	_, stdout, _ = firstRunExec(t, h, "update", "--output", "table")
	if strings.TrimSpace(stdout) != "alethia v2.0.0 is already up to date." {
		t.Errorf("stdout = %q", stdout)
	}
}

func TestFirstRun_UpdateResultAndItsSentence(t *testing.T) {
	for name, tc := range map[string]struct {
		outcome    update.Outcome
		wantAction ResultAction
		wantSay    string
	}{
		"updated":         {update.Outcome{From: "1.0.0", To: "1.1.0", Updated: true}, ResultUpdated, "Updated alethia to v1.1.0."},
		"deferred":        {update.Outcome{From: "1.0.0", To: "1.1.0", Deferred: true}, ResultUpdated, "finishes installing"},
		"already current": {update.Outcome{From: "1.1.0", To: "1.1.0"}, ResultUnchanged, "v1.1.0 is already up to date"},
	} {
		t.Run(name, func(t *testing.T) {
			result := updateResult(tc.outcome)
			if result.Action != tc.wantAction || result.DryRun || result.Kind != "cli" {
				t.Errorf("result: %+v", result)
			}
			var buf bytes.Buffer
			renderUpdate(&buf, tc.outcome)
			if !strings.Contains(buf.String(), tc.wantSay) {
				t.Errorf("sentence %q does not carry %q", buf.String(), tc.wantSay)
			}
		})
	}
}

// ── open ──────────────────────────────────────────────────────────────────────────────────

// firstRunBrowser records the URLs a browser was sent to, and fails each launch with failWith.
func firstRunBrowser(t *testing.T, failWith error) *[]string {
	t.Helper()
	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error {
		opened = append(opened, url)
		return failWith
	}
	t.Cleanup(func() { openBrowser = prev })
	return &opened
}

func TestFirstRun_OpenPrintWritesTheURLAndOpensNothing(t *testing.T) {
	resetFlagsAroundTest(t)
	h := upEnv(t, &projServer{})
	opened := firstRunBrowser(t, nil)

	code, stdout, stderr := firstRunExec(t, h, "open", "docs", "--print", "--no-input")
	if code != -1 {
		t.Fatalf("open exited %d\n%s", code, stderr)
	}
	if strings.TrimSpace(stdout) != docsURL {
		t.Errorf("stdout = %q, want the URL alone", stdout)
	}
	if len(*opened) != 0 {
		t.Errorf("--print opened a browser at %v", *opened)
	}

	_, stdout, _ = firstRunExec(t, h, "open", "docs", "--print", "--no-input", "--output", "json")
	var doc OpenResult
	dec := json.NewDecoder(strings.NewReader(stdout))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("stdout is not the result: %v\n%s", err, stdout)
	}
	if doc != (OpenResult{Target: openTargetDocs, URL: docsURL}) {
		t.Errorf("%+v", doc)
	}

	_, stdout, _ = firstRunExec(t, h, "open", "docs", "--print", "--no-input", "--output", "csv")
	if !strings.HasPrefix(stdout, strings.Join(openColumns, ",")) {
		t.Errorf("csv form:\n%s", stdout)
	}
}

func TestFirstRun_OpenLaunchesABrowserAndSaysSoOnStderr(t *testing.T) {
	resetFlagsAroundTest(t)
	h := upEnv(t, &projServer{})
	opened := firstRunBrowser(t, nil)

	code, stdout, stderr := firstRunExec(t, h, "open", "dashboard", "--no-input", "--output", "table")
	if code != -1 || len(*opened) != 1 {
		t.Fatalf("exit %d, opened %v\n%s", code, *opened, stderr)
	}
	if stdout != "" {
		t.Errorf("a launched browser leaves nothing to print on stdout, got %q", stdout)
	}
	if !strings.Contains(stderr, "Opening "+(*opened)[0]) {
		t.Errorf("stderr does not say where it went:\n%s", stderr)
	}

	// In json the document says a browser was opened.
	_, stdout, _ = firstRunExec(t, h, "open", "docs", "--no-input", "--output", "json")
	if !strings.Contains(stdout, `"opened": true`) && !strings.Contains(stdout, `"opened":true`) {
		t.Errorf("the document does not report the launch:\n%s", stdout)
	}
}

// A browser that will not launch is reported, and the URL still reaches the person: on stdout,
// because nothing was opened.
func TestFirstRun_OpenWithNoBrowserStillGivesTheURL(t *testing.T) {
	resetFlagsAroundTest(t)
	h := upEnv(t, &projServer{})
	firstRunBrowser(t, errBoom)
	code, stdout, stderr := firstRunExec(t, h, "open", "docs", "--no-input", "--output", "table")
	if code != -1 {
		t.Fatalf("open exited %d", code)
	}
	if strings.TrimSpace(stdout) != docsURL || !strings.Contains(stderr, "--print") {
		t.Errorf("stdout %q\nstderr:\n%s", stdout, stderr)
	}
}

// An agent is given the URL and no browser is launched on its machine.
func TestFirstRun_OpenForAnAgentOpensNothing(t *testing.T) {
	resetFlagsAroundTest(t)
	h := upEnv(t, &projServer{})
	opened := firstRunBrowser(t, nil)
	code, stdout, stderr := firstRunExec(t, h, "open", "docs", "--agent", "yes")
	if code != -1 {
		t.Fatalf("open exited %d\n%s", code, stderr)
	}
	if len(*opened) != 0 {
		t.Errorf("a browser was launched for an agent at %v", *opened)
	}
	var doc OpenResult
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil || doc.URL != docsURL || doc.Opened {
		t.Errorf("stdout %q (%v)", stdout, err)
	}
}

func TestFirstRun_OpenRefusals(t *testing.T) {
	resetFlagsAroundTest(t)
	h := upEnv(t, &projServer{})
	opened := firstRunBrowser(t, nil)
	for _, tc := range []struct {
		name string
		args []string
		exit int
	}{
		{"an unknown target", []string{"open", "nowhere"}, clierr.ExitUsage},
		{"--project with the docs", []string{"open", "docs", "--project", "web"}, clierr.ExitUsage},
		{"a project the organization does not have", []string{"open", "--project", "nope"}, clierr.ExitNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetAllFlags()
			code, stdout, stderr := firstRunExec(t, h, append(tc.args, "--no-input")...)
			if code != tc.exit || stdout != "" {
				t.Errorf("exit %d (want %d), stdout %q\n%s", code, tc.exit, stdout, stderr)
			}
			if !strings.Contains(stderr, "hint") {
				t.Errorf("the refusal carries no next step:\n%s", stderr)
			}
		})
	}
	if len(*opened) != 0 {
		t.Errorf("a refusal still opened a browser at %v", *opened)
	}
}

// ── the registry ──────────────────────────────────────────────────────────────────────────

// Every command of the family has an example, and every example is one a reader can run as
// written: it names a command of this CLI, every flag it passes is a flag that command has, and
// it carries no placeholder to be filled in from somewhere else.
func TestFirstRun_EveryCommandHasARunnableExample(t *testing.T) {
	if len(metaShell) == 0 {
		t.Fatal("the family has no entries, so nothing below would be asserted")
	}
	for _, m := range metaShell {
		if len(m.Examples) == 0 {
			t.Errorf("%s has no example", m.Path)
		}
		for _, ex := range m.Examples {
			if strings.ContainsAny(ex.Cmd, "<>") {
				t.Errorf("%s: example %q carries a placeholder", m.Path, ex.Cmd)
			}
			if ex.Note == "" {
				t.Errorf("%s: example %q does not say what it does", m.Path, ex.Cmd)
			}
			tokens := strings.Fields(ex.Cmd)
			if tokens[0] != "alethia" {
				t.Errorf("%s: example %q does not start with the program name", m.Path, ex.Cmd)
				continue
			}
			var words []string
			for _, tok := range tokens[1:] {
				if strings.HasPrefix(tok, "-") {
					break
				}
				words = append(words, tok)
			}
			found, _, err := rootCmd.Find(words)
			if err != nil {
				t.Errorf("%s: example %q does not resolve: %v", m.Path, ex.Cmd, err)
				continue
			}
			for _, tok := range tokens[1:] {
				if !strings.HasPrefix(tok, "--") {
					continue
				}
				name, _, _ := strings.Cut(strings.TrimPrefix(tok, "--"), "=")
				if found.Flags().Lookup(name) == nil && found.InheritedFlags().Lookup(name) == nil {
					t.Errorf("%s: example %q passes --%s, which `%s` does not take", m.Path, ex.Cmd, name, found.CommandPath())
				}
			}
		}
	}
}

// ── the small pieces ──────────────────────────────────────────────────────────────────────

// A manifest that cannot be read decides no account, so the runner step runs without one and
// the apply then reports the file. With no runner either, the runner refusal comes first.
func TestFirstRun_UpWithAManifestItCannotRead(t *testing.T) {
	for name, tc := range map[string]struct {
		runners  []map[string]any
		wantExit int
		wantSay  string
	}{
		"and a runner":  {nil, clierr.ExitUnclassified, manifest.FileName},
		"and no runner": {[]map[string]any{}, clierr.ExitConflict, "nothing would claim this deploy"},
	} {
		t.Run(name, func(t *testing.T) {
			h := upEnv(t, &projServer{twoIdentities: true, runners: tc.runners})
			dir := chdirTo(t)
			if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte("project: [unclosed"), 0o644); err != nil {
				t.Fatal(err)
			}
			code, stdout, stderr := firstRunExec(t, h, "up", "--no-input", "--yes")
			if code != tc.wantExit || stdout != "" || !strings.Contains(stderr, tc.wantSay) {
				t.Errorf("exit %d (want %d), stdout %q\n%s", code, tc.wantExit, stdout, stderr)
			}
		})
	}
}

// An agent reads the steps as bare sentences: no glyph to strip.
func TestFirstRun_StepForAnAgentIsTheBareSentence(t *testing.T) {
	p, _, errOut := firstRunPrinter(ui.FormatJSON)
	p.Mode.Agent = true
	firstRunStep(p, "Wrote alethia.yaml")
	if errOut.String() != "Wrote alethia.yaml\n" {
		t.Errorf("agent step = %q", errOut.String())
	}
	person, _, personErr := firstRunPrinter(ui.FormatTable)
	firstRunStep(person, "Wrote alethia.yaml")
	if personErr.String() != ui.SymbolSuccess+" Wrote alethia.yaml\n" {
		t.Errorf("person step = %q", personErr.String())
	}
}

// A result with no rows refuses csv on the fatal path rather than printing something else.
func TestFirstRun_EmitRefusesAFormatTheResultDoesNotHave(t *testing.T) {
	prevPrinter, prevExit := printer, exitFunc
	p, out, _ := firstRunPrinter(ui.FormatCSV)
	printer = p
	code := -1
	exitFunc = func(c int) { code = c }
	t.Cleanup(func() { printer, exitFunc = prevPrinter, prevExit })

	_, readErr := captureStderr(t)
	firstRunEmit(struct{ Name string }{"x"}, nil)
	stderr := readErr()
	if code != clierr.ExitUsage || out.Len() != 0 || !strings.Contains(stderr, "csv") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, out.String(), stderr)
	}
}

// With the control plane unreachable, `version` falls back on the release the last check cached.
func TestFirstRun_VersionFallsBackOnTheCachedRelease(t *testing.T) {
	isolatedHome(t)
	t.Setenv(noUpdateCheckEnv, "")
	dir, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "alethia"), 0o755); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(dir, "alethia", "update-check.json")
	if err := os.WriteFile(cache, []byte(`{"latest_version":"3.1.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := latestRelease("1.0.0", "http://127.0.0.1:1"); got != "3.1.0" {
		t.Errorf("latest = %q, want the cached 3.1.0", got)
	}
}
