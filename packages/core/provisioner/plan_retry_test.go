// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runTLSTimeoutErr is the plan error CAPTURED from the 2026-10-07 hetzner floor nightly,
// run 37605979423: the "err" field of the runner's `job execution failed` log line
// (`gh run view 37605979423 --log-failed`), pasted verbatim with only deploy.go's own
// "tofu plan failed: " prefix removed — that prefix is added AFTER the retry decision.
// Note tofu broke the line BEFORE `net/http:`, so this pattern sits on one line.
var runTLSTimeoutErr = errors.New("exit status 1\n\nError: failed to get talos extensions versions\n\n  with data.talos_image_factory_extensions_versions.this,\n  on image.tf line 248, in data \"talos_image_factory_extensions_versions\" \"this\":\n 248: data \"talos_image_factory_extensions_versions\" \"this\" {\n\nGet \"https://factory.talos.dev/version/v1.13.6/extensions/official\":\nnet/http: TLS handshake timeout\n")

// syntheticWrappedErr is NOT captured from any run. It is the case the whitespace
// normalisation in transientPlanErrorReason exists for: tofu word-wraps a diagnostic's
// detail (at 78 columns when stderr is not a terminal), and a break can land INSIDE a
// pattern. Run 37605979423's break happened to fall before the pattern; this one does not.
var syntheticWrappedErr = errors.New("exit status 1\n\nError: failed to query available provider packages\n\n" +
	"Could not retrieve the list of available versions for provider hetznercloud/hcloud: could not\n" +
	"connect to registry.opentofu.org: Get \"https://registry.opentofu.org/v1/providers/\": net/http: TLS\n" +
	"handshake timeout\n")

// recordingPolicy returns a planRetryPolicy whose Sleep records each wait instead of
// sleeping, plus a pointer to those recorded waits.
func recordingPolicy() (planRetryPolicy, *[]time.Duration) {
	var waits []time.Duration
	return planRetryPolicy{
		Backoff: 7 * time.Second,
		Sleep: func(_ context.Context, d time.Duration) error {
			waits = append(waits, d)
			return nil
		},
	}, &waits
}

// scriptedPlan returns a plan func that returns errs[i] on its i-th call (nil past the
// end), plus a pointer to the call count.
func scriptedPlan(errs ...error) (func(context.Context) error, *int) {
	calls := 0
	return func(context.Context) error {
		i := calls
		calls++
		if i < len(errs) {
			return errs[i]
		}
		return nil
	}, &calls
}

// TestPlanRetry_TransientErrorIsRetriedExactlyOnce pins the #5644 behaviour: the TLS
// timeout from run 37605979423 is retried once, after the backoff, and the retry is logged
// with its reason.
func TestPlanRetry_TransientErrorIsRetriedExactlyOnce(t *testing.T) {
	policy, waits := recordingPolicy()
	plan, calls := scriptedPlan(runTLSTimeoutErr, nil)
	var out bytes.Buffer

	if err := policy.run(context.Background(), &out, plan); err != nil {
		t.Fatalf("plan should succeed on its retry, got %v", err)
	}
	if *calls != 2 {
		t.Fatalf("plan calls = %d, want 2 (one try, one retry)", *calls)
	}
	if len(*waits) != 1 || (*waits)[0] != 7*time.Second {
		t.Fatalf("waits = %v, want exactly one backoff of 7s", *waits)
	}
	log := out.String()
	if !strings.Contains(log, "retrying once") || !strings.Contains(log, "net/http: TLS handshake timeout") {
		t.Fatalf("retry must be logged with its reason, got log %q", log)
	}
}

// TestPlanRetry_PatternWrappedAcrossLinesStillMatches pins the whitespace normalisation
// against the SYNTHETIC wrapped fixture (see syntheticWrappedErr — no run produced it).
func TestPlanRetry_PatternWrappedAcrossLinesStillMatches(t *testing.T) {
	reason, transient := transientPlanErrorReason(syntheticWrappedErr)
	if !transient || reason != "net/http: TLS handshake timeout" {
		t.Fatalf("got (%q, %v); a pattern tofu wrapped across lines must still match", reason, transient)
	}
}

// TestPlanRetry_SecondTransientFailureFails: one retry only — a second transient failure
// fails the plan, and the error says a retry happened.
func TestPlanRetry_SecondTransientFailureFails(t *testing.T) {
	policy, waits := recordingPolicy()
	second := errors.New("exit status 1\nError: Get \"https://api.hetzner.cloud/v1/servers\": dial tcp 1.2.3.4:443: i/o timeout")
	plan, calls := scriptedPlan(runTLSTimeoutErr, second, nil)

	err := policy.run(context.Background(), &bytes.Buffer{}, plan)
	if err == nil {
		t.Fatal("a second transient failure must fail the plan")
	}
	if *calls != 2 {
		t.Fatalf("plan calls = %d, want 2 — the retry happens ONCE", *calls)
	}
	if len(*waits) != 1 {
		t.Fatalf("waits = %v, want exactly one", *waits)
	}
	if !errors.Is(err, second) {
		t.Fatalf("error must wrap the retry's failure, got %v", err)
	}
	if !strings.Contains(err.Error(), "after one retry") {
		t.Fatalf("error must say a retry happened, got %v", err)
	}
}

// TestPlanRetry_NonTransientErrorIsNeverRetried: a real plan error (bad config, auth,
// quota) fails immediately with no wait, exactly as before #5644.
func TestPlanRetry_NonTransientErrorIsNeverRetried(t *testing.T) {
	for _, msg := range []string{
		"exit status 1\nError: Reference to undeclared input variable",
		"exit status 1\nError: unable to authenticate: invalid token (401)",
		"exit status 1\nError: server limit exceeded",
		"exit status 1\nError: timeout while waiting for state to become 'running'",
	} {
		t.Run(msg, func(t *testing.T) {
			policy, waits := recordingPolicy()
			want := errors.New(msg)
			plan, calls := scriptedPlan(want, nil)
			var out bytes.Buffer

			err := policy.run(context.Background(), &out, plan)
			if !errors.Is(err, want) || err.Error() != msg {
				t.Fatalf("error = %v, want the original error unchanged", err)
			}
			if *calls != 1 || len(*waits) != 0 {
				t.Fatalf("calls = %d, waits = %v; a non-transient error must not be retried", *calls, *waits)
			}
			if out.Len() != 0 {
				t.Fatalf("no retry means no retry log, got %q", out.String())
			}
		})
	}
}

// TestPlanRetry_EveryListedPatternIsTransient walks the pattern list itself, so an entry
// added there is covered, and checks each against realistic provider error text.
func TestPlanRetry_EveryListedPatternIsTransient(t *testing.T) {
	samples := map[string]string{
		"net/http: TLS handshake timeout":      `Get "https://factory.talos.dev/": net/http: TLS handshake timeout`,
		"i/o timeout":                          "dial tcp 1.2.3.4:443: i/o timeout",
		"connection reset by peer":             "read tcp 10.0.0.1:5555->1.2.3.4:443: read: connection reset by peer",
		"connection refused":                   "dial tcp 127.0.0.1:443: connect: connection refused",
		"Temporary failure in name resolution": "dial tcp: lookup api.hetzner.cloud on 127.0.0.53:53: Temporary failure in name resolution",
	}
	if len(samples) != len(transientPlanErrorPatterns) {
		t.Fatalf("%d samples for %d patterns — add a sample for every pattern", len(samples), len(transientPlanErrorPatterns))
	}
	for _, p := range transientPlanErrorPatterns {
		sample, ok := samples[p.pattern]
		if !ok {
			t.Fatalf("no sample for pattern %q", p.pattern)
		}
		if p.source == "" {
			t.Fatalf("pattern %q must say where it came from", p.pattern)
		}
		reason, transient := transientPlanErrorReason(errors.New("exit status 1\nError: " + sample))
		if !transient || reason != p.pattern {
			t.Fatalf("sample %q: got (%q, %v), want (%q, true)", sample, reason, transient, p.pattern)
		}
	}
	if _, transient := transientPlanErrorReason(nil); transient {
		t.Fatal("a nil error is not transient")
	}
}

// TestPlanRetry_CancelledContextIsNotRetried: a cancelled job stops — neither a failure
// that arrives with ctx already done, nor one whose backoff is cut short, is retried.
func TestPlanRetry_CancelledContextIsNotRetried(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	policy, waits := recordingPolicy()
	plan, calls := scriptedPlan(runTLSTimeoutErr, nil)
	if err := policy.run(ctx, &bytes.Buffer{}, plan); !errors.Is(err, runTLSTimeoutErr) {
		t.Fatalf("error = %v, want the original", err)
	}
	if *calls != 1 || len(*waits) != 0 {
		t.Fatalf("calls = %d, waits = %v; a cancelled ctx must not retry", *calls, *waits)
	}

	interrupted := planRetryPolicy{Backoff: time.Hour, Sleep: func(context.Context, time.Duration) error {
		return context.Canceled
	}}
	plan2, calls2 := scriptedPlan(runTLSTimeoutErr, nil)
	if err := interrupted.run(context.Background(), &bytes.Buffer{}, plan2); !errors.Is(err, runTLSTimeoutErr) {
		t.Fatalf("error = %v, want the original", err)
	}
	if *calls2 != 1 {
		t.Fatalf("calls = %d; an interrupted backoff must not retry", *calls2)
	}
}

// TestSleepCtx covers the real wait: it returns nil after d, and ctx's error once
// ctx is done.
func TestSleepCtx(t *testing.T) {
	if err := sleepCtx(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("sleepCtx = %v, want nil", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sleepCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("sleepCtx on a cancelled ctx = %v, want context.Canceled", err)
	}
	if defaultPlanRetry.Backoff <= 0 || defaultPlanRetry.Sleep == nil {
		t.Fatal("defaultPlanRetry must have a positive backoff and a Sleep")
	}
}

// refusedPlanModuleTF is a provider-less module (built-in terraform_remote_state, so
// `tofu init` downloads nothing) whose PLAN reads a remote state from a closed localhost
// port — a real `connection refused` produced by tofu itself, at plan time, not init.
const refusedPlanModuleTF = `terraform {
  backend "http" {}
}

data "terraform_remote_state" "unreachable" {
  backend = "http"
  config = {
    address   = "%s"
    retry_max = 0
  }
}
`

// TestRunDeployV2_PlanGoesThroughTheRetry pins the CALL SITE: RunDeployV2's plan must run
// through defaultPlanRetry. It drives the real RunDeployV2 (dry run) against a module whose
// plan fails with a real `connection refused`, swaps only defaultPlanRetry's Sleep for a
// recorder, and asserts exactly one backoff, the retry log line and the wrapped error.
// Reverting deploy.go to a bare tf.Plan leaves the recorder empty and fails this test.
func TestRunDeployV2_PlanGoesThroughTheRetry(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping (bare CI without OpenTofu)")
	}

	// A localhost port that was just free and is now closed: dialing it is refused.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedAddr := "http://" + ln.Addr().String() + "/state"
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}

	modDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(modDir, "main.tf"), []byte(fmt.Sprintf(refusedPlanModuleTF, closedAddr)), 0o644); err != nil {
		t.Fatal(err)
	}

	var waits []time.Duration
	saved := defaultPlanRetry
	defaultPlanRetry.Sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	t.Cleanup(func() { defaultPlanRetry = saved })

	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	_, err = RunDeployV2(ctx, DeployParams{
		ProjectConfig: newLocalProjectConfig("alethia", "retry"+shortID(t)),
		Provider:      "hetzner",
		TemplatesDir:  modDir,
		StateBackend:  testStateBackend(startTestStateServer(t)),
		DryRun:        true,
		Stdout:        &out,
		Stderr:        io.Discard,
	})
	if err == nil {
		t.Fatal("RunDeployV2 should fail: the remote state is unreachable on every plan")
	}
	if !strings.Contains(err.Error(), "tofu plan failed") || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("expected the plan to fail on connection refused, got %v", err)
	}
	if len(waits) != 1 || waits[0] != saved.Backoff {
		t.Fatalf("backoff waits = %v, want exactly one of %s — RunDeployV2's plan did not go through defaultPlanRetry", waits, saved.Backoff)
	}
	if !strings.Contains(err.Error(), "after one retry") {
		t.Fatalf("error must say the plan was retried once, got %v", err)
	}
	if !strings.Contains(out.String(), `retrying once in`) {
		t.Fatalf("the retry must be logged to the job's stdout, got:\n%s", out.String())
	}
}
