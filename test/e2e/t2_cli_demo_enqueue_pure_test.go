// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// #5090: the first cli-demo run past #5061 (36130590853, hetzner) died on the `apply` beat with
// "Environment is not in a valid state for this operation — a job may already be in progress".
// `project plan` had queued a PLAN (env → QUEUED), no runner was running yet to take it, and
// `project apply` was refused, because an env admits one job in flight (`enqueueDeploy` excludes
// QUEUED). These tests hold the three things that make the enqueue beats legal: the jobs are
// serialised, the phase runs where a runner exists, and the wait for the env to settle reports the
// mechanism when it runs out.

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"slices"
	"strings"
	"testing"
	"time"
)

// cliDemoSpineAwaitedStep is the one enqueue beat whose job the SPINE waits on to terminal
// (cp.WaitTerminal on CLIDemoRun.ApplyJobID) instead of the CLI's `--wait`.
const cliDemoSpineAwaitedStep = "apply"

// cliDemoEnqueuesAJob reports whether argv queues a lifecycle job — the verbs whose enqueue moves
// the environment through the env-status CAS.
func cliDemoEnqueuesAJob(argv []string) bool {
	return len(argv) >= 2 && argv[0] == "project" &&
		(argv[1] == "plan" || argv[1] == "apply" || argv[1] == "destroy")
}

// TestCLIDemoEnqueueBeatsNeverOverlapOnOneEnv: of two beats that each queue a job on the run's
// environment, the EARLIER one's job must be terminal before the later one runs — by `--wait`, or
// by being the job the spine waits on — and the later one must wait for the env to settle.
//
// Before #5090 this failed on {plan → apply}: `plan` carried no `--wait` and `apply` did not wait,
// which is exactly the pair the console refused.
func TestCLIDemoEnqueueBeatsNeverOverlapOnOneEnv(t *testing.T) {
	var prev *CLIDemoBeat
	pairs := 0
	for i := range CLIDemoBeats {
		b := &CLIDemoBeats[i]
		if !cliDemoEnqueuesAJob(b.Args(&CLIDemoRun{})) {
			continue
		}
		if prev != nil {
			pairs++
			prevArgv := prev.Args(&CLIDemoRun{})
			if !slices.Contains(prevArgv, "--wait") && prev.StepID != cliDemoSpineAwaitedStep {
				t.Errorf("beat %q queues a job and nothing waits for it before beat %q queues the next "+
					"one on the same environment — the console refuses the second (409, #5090). Pass "+
					"--wait on %q.", prev.StepID, b.StepID, prev.StepID)
			}
			if !b.AwaitEnvSettled {
				t.Errorf("beat %q queues a job after beat %q did, but does not set AwaitEnvSettled — "+
					"under the shim the env stays QUEUED after %q's job ends, until the convergence "+
					"backstop settles it (#5090).", b.StepID, prev.StepID, prev.StepID)
			}
		}
		prev = b
	}
	// Non-vacuity: plan → apply → destroy is two pairs. Fewer means the verbs were renamed and this
	// test examined nothing.
	if pairs < 2 {
		t.Fatalf("found %d consecutive enqueue pair(s), want at least 2 (plan→apply, apply→destroy) — "+
			"this test is no longer examining the beats it was written for", pairs)
	}
}

// TestCLIDemoEnqueuePhaseRunsAfterTheRunnerStarts pins WHERE the spine drives the enqueue phase:
// after the runner process starts. `project plan --wait` blocks on a claimer, so driving it before
// startT2RunnerProc would hang until the beat's bound and report as the CLI being unable to plan.
//
// Read with go/parser, not grepped: the phase name also appears in comments.
func TestCLIDemoEnqueuePhaseRunsAfterTheRunnerStarts(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "t2_provision_test.go", nil, 0)
	if err != nil {
		t.Fatalf("parse t2_provision_test.go: %v", err)
	}
	var enqueueAt, runnerAt []token.Pos
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok {
			return true
		}
		switch id.Name {
		case "startT2RunnerProc":
			runnerAt = append(runnerAt, call.Pos())
		case "DriveCLIDemoPhase":
			if len(call.Args) == 4 {
				if ph, ok := call.Args[3].(*ast.Ident); ok && ph.Name == "CLIDemoEnqueue" {
					enqueueAt = append(enqueueAt, call.Pos())
				}
			}
		}
		return true
	})
	if len(runnerAt) != 1 {
		t.Fatalf("found %d startT2RunnerProc call(s) in t2_provision_test.go, want exactly 1", len(runnerAt))
	}
	if len(enqueueAt) != 1 {
		t.Fatalf("found %d DriveCLIDemoPhase(…, CLIDemoEnqueue) call(s) in t2_provision_test.go, want exactly 1", len(enqueueAt))
	}
	if enqueueAt[0] < runnerAt[0] {
		t.Errorf("the enqueue phase is driven at %s, BEFORE the runner process starts at %s — "+
			"`project plan --wait` would block on a claimer that does not exist yet (#5090)",
			fset.Position(enqueueAt[0]), fset.Position(runnerAt[0]))
	}
}

// withFastEnvSettle shrinks the settle loop so the pure tests run in milliseconds.
func withFastEnvSettle(t *testing.T) {
	t.Helper()
	prevPoll, prevWindow := cliDemoEnvSettlePoll, cliDemoEnvSettleWindow
	cliDemoEnvSettlePoll, cliDemoEnvSettleWindow = time.Millisecond, 30*time.Millisecond
	t.Cleanup(func() { cliDemoEnvSettlePoll, cliDemoEnvSettleWindow = prevPoll, prevWindow })
}

// TestAwaitCLIDemoEnvSettledReturnsOnceTheEnvLeavesFlight: QUEUED, then a read error, then DRAFT —
// the wait keeps going through the first two and returns on the third.
func TestAwaitCLIDemoEnvSettledReturnsOnceTheEnvLeavesFlight(t *testing.T) {
	withFastEnvSettle(t)
	reads := 0
	err := awaitCLIDemoEnvSettled(context.Background(), &CLIDemoRun{EnvName: "development"},
		func(context.Context) (string, error) {
			reads++
			switch reads {
			case 1:
				return "QUEUED", nil
			case 2:
				return "", errors.New("console hiccup")
			default:
				return "DRAFT", nil
			}
		})
	if err != nil {
		t.Fatalf("settled env reported as unsettled: %v", err)
	}
	if reads != 3 {
		t.Fatalf("read the status %d time(s), want 3", reads)
	}
}

// TestAwaitCLIDemoEnvSettledNamesTheMechanismWhenItRunsOut: an env stuck QUEUED fails with a
// message that names the shim and the convergence backstop — the two facts that turn "the CLI is
// broken" into the actual cause.
func TestAwaitCLIDemoEnvSettledNamesTheMechanismWhenItRunsOut(t *testing.T) {
	withFastEnvSettle(t)
	err := awaitCLIDemoEnvSettled(context.Background(),
		&CLIDemoRun{EnvName: "development", ProjectID: "p-1"},
		func(context.Context) (string, error) { return "QUEUED", nil })
	if err == nil {
		t.Fatal("an env that never left QUEUED was reported as settled")
	}
	for _, want := range []string{`"development"`, "QUEUED", "409", "Go shim", "lib/reconcile/converge.ts", "ALETHIA_CONVERGE_MIN_AGE_MINUTES"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("failure message does not name %q:\n%v", want, err)
		}
	}
}

// TestAwaitCLIDemoEnvSettledTreatsEveryInFlightStatusAsInFlight: each status the enqueue from-sets
// exclude keeps the wait going; each settled one ends it.
func TestAwaitCLIDemoEnvSettledTreatsEveryInFlightStatusAsInFlight(t *testing.T) {
	withFastEnvSettle(t)
	for _, s := range []string{"QUEUED", "PROVISIONING", "DESTROYING"} {
		err := awaitCLIDemoEnvSettled(context.Background(), &CLIDemoRun{EnvName: "e"},
			func(context.Context) (string, error) { return s, nil })
		if err == nil {
			t.Errorf("%s was treated as settled", s)
		}
	}
	for _, s := range []string{"DRAFT", "ACTIVE", "FAILED", "DESTROYED"} {
		err := awaitCLIDemoEnvSettled(context.Background(), &CLIDemoRun{EnvName: "e"},
			func(context.Context) (string, error) { return s, nil })
		if err != nil {
			t.Errorf("%s was treated as in flight: %v", s, err)
		}
	}
}

// TestCLIDemoEnvStatusFromRefusesWhatItCannotFind: a missing env or a blank status is an ERROR, not
// the empty string — "" is not an in-flight status, so returning it would end the wait on an
// environment that was never read.
func TestCLIDemoEnvStatusFromRefusesWhatItCannotFind(t *testing.T) {
	out := []byte(`[{"name":"development","status":"QUEUED"},{"name":"preview","status":""}]`)
	if s, err := cliDemoEnvStatusFrom(out, "development"); err != nil || s != "QUEUED" {
		t.Fatalf("development: got (%q, %v), want (QUEUED, nil)", s, err)
	}
	if _, err := cliDemoEnvStatusFrom(out, "preview"); err == nil {
		t.Error("a blank status was returned as a status")
	}
	if _, err := cliDemoEnvStatusFrom(out, "production"); err == nil {
		t.Error("an absent environment was returned as a status")
	}
	if _, err := cliDemoEnvStatusFrom([]byte("No environments found."), "development"); err == nil {
		t.Error("output with no JSON array was parsed as a status")
	}
}
