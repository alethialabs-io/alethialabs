// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"os"
	"testing"
)

// TestCancelRegistry_CancelsRegisteredJob proves cancel() invokes the RIGHT job's cancel
// function (cancelling its context) and records the cancellation.
func TestCancelRegistry_CancelsRegisteredJob(t *testing.T) {
	r := newCancelRegistry()

	ctxA, cancelA := context.WithCancel(context.Background())
	defer cancelA()
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	r.register("job-a", cancelA)
	r.register("job-b", cancelB)

	if !r.cancel("job-a") {
		t.Fatal("cancel(job-a) should report a live job was cancelled")
	}
	select {
	case <-ctxA.Done():
	default:
		t.Fatal("job-a context should be cancelled")
	}
	select {
	case <-ctxB.Done():
		t.Fatal("job-b context must NOT be cancelled by cancelling job-a")
	default:
	}
	if !r.wasCancelled("job-a") {
		t.Error("wasCancelled(job-a) should be true")
	}
	if r.wasCancelled("job-b") {
		t.Error("wasCancelled(job-b) should be false")
	}
}

// TestCancelRegistry_CancelUnknownJob covers the QUEUED-job case: a cancel for a job that
// isn't running here marks it cancelled but reports no live teardown.
func TestCancelRegistry_CancelUnknownJob(t *testing.T) {
	r := newCancelRegistry()
	if r.cancel("ghost") {
		t.Error("cancel of a non-running job should return false")
	}
	if !r.wasCancelled("ghost") {
		t.Error("a cancel still marks the job cancelled even if not running")
	}
}

// TestCancelRegistry_OrphanRisk covers the orphan-risk flag lifecycle.
func TestCancelRegistry_OrphanRisk(t *testing.T) {
	r := newCancelRegistry()
	if r.orphanRisk("job-x") {
		t.Fatal("orphan risk should default false")
	}
	r.markOrphanRisk("job-x")
	if !r.orphanRisk("job-x") {
		t.Error("orphan risk should be true after markOrphanRisk")
	}
}

// TestCancelRegistry_ReapClears proves reap removes all trace of a finished job.
func TestCancelRegistry_ReapClears(t *testing.T) {
	r := newCancelRegistry()
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.register("job-1", cancel)
	r.cancel("job-1")
	r.markOrphanRisk("job-1")

	r.reap("job-1")
	if r.wasCancelled("job-1") || r.orphanRisk("job-1") {
		t.Error("reap should clear cancelled + orphan flags")
	}
}

// TestDispatchWakeEvent routes wake → trigger and cancel → registry teardown.
func TestDispatchWakeEvent(t *testing.T) {
	w := NewWithAPI(Config{Operator: "self"}, &mockAPI{})

	triggered := 0
	trigger := func() { triggered++ }

	// A wake triggers a claim drain.
	w.dispatchWakeEvent(WakeEvent{Type: "wake"}, trigger)
	if triggered != 1 {
		t.Errorf("wake should trigger a claim; got %d", triggered)
	}

	// A cancel tears down the targeted in-flight job (and does NOT trigger a claim).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.cancels.register("job-c", cancel)
	w.dispatchWakeEvent(WakeEvent{Type: "cancel", JobID: "job-c"}, trigger)
	if triggered != 1 {
		t.Errorf("a cancel must not trigger a claim; triggered=%d", triggered)
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("cancel event should have cancelled job-c's context")
	}
}

// TestParseWakeLine covers typed wake/cancel parsing + the legacy `data: wake` fallback.
func TestParseWakeLine(t *testing.T) {
	tests := []struct {
		name     string
		line     string
		wantOK   bool
		wantType string
		wantJob  string
	}{
		{"typed wake", `data: {"type":"wake"}`, true, "wake", ""},
		{"typed cancel", `data: {"type":"cancel","job_id":"job-9"}`, true, "cancel", "job-9"},
		{"legacy bare wake", "data: wake", true, "wake", ""},
		{"malformed json falls back to wake", "data: {not json", true, "wake", ""},
		{"comment/heartbeat ignored", ":", false, "", ""},
		{"blank ignored", "", false, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev, ok := parseWakeLine(tt.line)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if ev.Type != tt.wantType {
				t.Errorf("type = %q, want %q", ev.Type, tt.wantType)
			}
			if ev.JobID != tt.wantJob {
				t.Errorf("job_id = %q, want %q", ev.JobID, tt.wantJob)
			}
		})
	}
}

// TestReadDeployPhase covers the phase-marker read used for orphan detection.
func TestReadDeployPhase(t *testing.T) {
	dir := t.TempDir()
	if got := readDeployPhase(dir); got != "" {
		t.Errorf("no phase file → want empty, got %q", got)
	}
	if err := os.WriteFile(deployPhaseFile(dir), []byte("apply\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readDeployPhase(dir); got != "apply" {
		t.Errorf("phase = %q, want apply", got)
	}
}
