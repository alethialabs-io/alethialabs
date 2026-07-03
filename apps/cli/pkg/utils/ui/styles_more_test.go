// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"
)

func TestEyebrow(t *testing.T) {
	got := Eyebrow("control plane")
	// Uppercased and letter-spaced.
	if !strings.Contains(got, "C") || !strings.Contains(got, "O") {
		t.Errorf("eyebrow not uppercased: %q", got)
	}
	if !strings.Contains(got, "C O") {
		t.Errorf("eyebrow not letter-spaced: %q", got)
	}
}

func TestRenderMark(t *testing.T) {
	if !strings.Contains(RenderMark(), Mark) {
		t.Errorf("RenderMark missing %q: %q", Mark, RenderMark())
	}
}

func TestPlainStatusDot(t *testing.T) {
	cases := map[string]string{
		"ONLINE":       SymbolOnline,
		"ACTIVE":       SymbolOnline,
		"DRAINING":     SymbolPending,
		"PROVISIONING": SymbolPending,
		"QUEUED":       SymbolPending,
		"FAILED":       SymbolError,
		"DESTROYED":    SymbolDash,
		"WHATEVER":     SymbolOffline,
	}
	for status, want := range cases {
		if got := PlainStatusDot(status); got != want {
			t.Errorf("PlainStatusDot(%q) = %q, want %q", status, got, want)
		}
	}
}

// The message helpers print to stdout; exercise them so a regression in the
// styling pipeline (e.g. a nil style) surfaces as a panic in tests.
func TestMessageHelpersDoNotPanic(t *testing.T) {
	Success("ok")
	Error("bad")
	Warning("warn")
	Info("info")
	Muted("muted")
	JobQueued("PLAN", "job-1")
}
