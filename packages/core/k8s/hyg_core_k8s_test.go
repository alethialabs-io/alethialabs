// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

// TestHygCoreK8sCancelledWaitIsReportedAsCancellation pins #2055: when the caller's context ends
// mid-wait, WaitClusterReady used to drop ctx.Err() (it was adopted only when lastErr was nil, which
// never holds once a probe has failed) and reported the stale probe verdict instead — so a cancelled
// deploy read as "NETWORK UNREACHABLE" and errors.Is(err, context.Canceled) was false.
//
// The probe error planted here is deliberately one classifyReachability buckets as reachNetwork, and
// the test asserts that precondition (the probe's text is carried into the message) before asserting
// the absence of the network verdict — otherwise a setup that never failed a probe would pass against
// the unfixed code and prove nothing.
func TestHygCoreK8sCancelledWaitIsReportedAsCancellation(t *testing.T) {
	resetK8sSeams(t)

	tests := []struct {
		name    string
		newCtx  func() (context.Context, context.CancelFunc)
		wantErr error
	}{
		{
			name: "the caller cancels",
			newCtx: func() (context.Context, context.CancelFunc) {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx, cancel
			},
			wantErr: context.Canceled,
		},
		{
			name: "the caller's deadline expires",
			newCtx: func() (context.Context, context.CancelFunc) {
				return context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			},
			wantErr: context.DeadlineExceeded,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			executeCommandWithOutput = func(string, string, []string) (string, error) {
				return "", errors.New("dial tcp 10.0.0.1:443: connect: connection refused")
			}
			ctx, cancel := tc.newCtx()
			defer cancel()

			err := WaitClusterReady(ctx, time.Hour, false, io.Discard)
			if err == nil {
				t.Fatal("WaitClusterReady returned nil for a cancelled wait")
			}
			// Precondition: a probe really did fail and its (network-classifiable) text reached the
			// message — so the "no NETWORK UNREACHABLE" assertion below is about the fix, not an
			// empty setup.
			if !strings.Contains(err.Error(), "connection refused") {
				t.Fatalf("the last probe error must survive as diagnostic context, got: %v", err)
			}
			if got := classifyReachability(errors.New("dial tcp 10.0.0.1:443: connect: connection refused"), ""); got != reachNetwork {
				t.Fatalf("planted probe error classifies as %v, want %v — the setup no longer reproduces the masking", got, reachNetwork)
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("errors.Is(err, %v) == false; a caller cannot tell a cancelled wait from a broken cluster.\ngot: %v", tc.wantErr, err)
			}
			if strings.Contains(err.Error(), string(reachNetwork)) || strings.Contains(err.Error(), "NETWORK UNREACHABLE") {
				t.Fatalf("a cancelled wait is reported as a network fault: %v", err)
			}
			if !strings.Contains(err.Error(), "NOT a cluster fault") {
				t.Fatalf("the message must say the cancellation is not a cluster fault, got: %v", err)
			}
		})
	}
}

// TestHygCoreK8sLastProbeDetail covers both arms of the cancelled-wait diagnostic suffix: a wait
// cancelled before any probe failed carries no parenthetical, and one that had a failure carries it.
func TestHygCoreK8sLastProbeDetail(t *testing.T) {
	if got := lastProbeDetail(nil); got != "" {
		t.Fatalf("lastProbeDetail(nil) = %q, want empty", got)
	}
	got := lastProbeDetail(errors.New("i/o timeout"))
	if !strings.Contains(got, "last probe error: i/o timeout") {
		t.Fatalf("lastProbeDetail = %q, want the probe error as context", got)
	}
}

// TestHygCoreK8sNonContextExitsStillClassify guards the neighbouring returns the cancellation fix
// must not disturb: an exhausted budget and an auth-rejected probe still classify from the last probe
// error, and neither may be mistaken for a context error.
func TestHygCoreK8sNonContextExitsStillClassify(t *testing.T) {
	resetK8sSeams(t)

	t.Run("an exhausted budget still reports the network verdict", func(t *testing.T) {
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "", errors.New("dial tcp 10.0.0.1:443: i/o timeout")
		}
		err := WaitClusterReady(context.Background(), 0, false, io.Discard)
		if err == nil || !strings.Contains(err.Error(), string(reachNetwork)) {
			t.Fatalf("WaitClusterReady error = %v, want the network verdict", err)
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("a budget timeout must not masquerade as a context error: %v", err)
		}
	})

	t.Run("an auth-rejected probe still reports the auth verdict", func(t *testing.T) {
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "error: You must be logged in to the server (Unauthorized)", errors.New("exit status 1")
		}
		err := WaitClusterReady(context.Background(), 0, false, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "AUTHENTICATION REJECTED") {
			t.Fatalf("WaitClusterReady error = %v, want the authentication verdict", err)
		}
	})
}
