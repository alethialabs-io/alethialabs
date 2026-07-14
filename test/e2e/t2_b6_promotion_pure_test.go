// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure unit tests for the B6.1 (gated promotion) helpers — UNTAGGED so they run in the every-PR
// `go test ./...` (no Postgres, no cloud, no build tag), exactly like argocd_assert_test.go and
// t2_console_active_pure_test.go. They pin the JSON shapes the DB seed writes + the gate_evaluations
// parser the run test asserts on, so a drift in either is caught on the fast per-PR path.

package e2e

import (
	"encoding/json"
	"testing"
)

func TestB6ParseGateEvaluation(t *testing.T) {
	t.Run("nil and null are a nil evaluation, not an error", func(t *testing.T) {
		for _, raw := range [][]byte{nil, {}, []byte("null")} {
			got, err := b6ParseGateEvaluation(raw)
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", raw, err)
			}
			if got != nil {
				t.Fatalf("want nil evaluation for %q, got %+v", raw, got)
			}
		}
	})

	t.Run("parses overall + per-type statuses", func(t *testing.T) {
		raw := []byte(`{"overall":"pending_approval","evaluated_at":"2026-07-14T00:00:00Z","results":[
			{"type":"manual_approval","status":"pending","detail":"0/1 approvals"},
			{"type":"verify_pass","status":"pass","detail":"No unwaived hard control failures"},
			{"type":"predecessor_healthy","status":"skipped","detail":"off"}]}`)
		got, err := b6ParseGateEvaluation(raw)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if got.Overall != "pending_approval" {
			t.Fatalf("overall = %q, want pending_approval", got.Overall)
		}
		for typ, want := range map[string]string{
			"manual_approval":     "pending",
			"verify_pass":         "pass",
			"predecessor_healthy": "skipped",
		} {
			if got.ByType[typ] != want {
				t.Fatalf("gate %q = %q, want %q", typ, got.ByType[typ], want)
			}
		}
	})

	t.Run("malformed JSON errors", func(t *testing.T) {
		if _, err := b6ParseGateEvaluation([]byte("{not json")); err == nil {
			t.Fatal("want an error for malformed JSON, got nil")
		}
	})
}

func TestB6VerifyResultMetadata(t *testing.T) {
	// Both variants must be valid JSON with a verify_result.controls array the gate engine reads.
	for _, fail := range []bool{false, true} {
		var doc struct {
			VerifyResult struct {
				Controls []struct {
					ID     string `json:"id"`
					Status string `json:"status"`
				} `json:"controls"`
			} `json:"verify_result"`
		}
		if err := json.Unmarshal([]byte(b6VerifyResultMetadata(fail)), &doc); err != nil {
			t.Fatalf("fail=%v: not valid JSON: %v", fail, err)
		}
		hardFailures := 0
		for _, c := range doc.VerifyResult.Controls {
			if c.Status == "fail" {
				hardFailures++
			}
		}
		if fail && hardFailures != 1 {
			t.Fatalf("fail=true: want exactly 1 failing control, got %d", hardFailures)
		}
		if !fail && hardFailures != 0 {
			t.Fatalf("fail=false: want 0 failing controls (clean report), got %d", hardFailures)
		}
	}
}

func TestB6Enforcement(t *testing.T) {
	var e struct {
		RequireApproval   bool `json:"require_approval"`
		RequireVerifyPass bool `json:"require_verify_pass"`
		MinApprovals      int  `json:"min_approvals"`
	}
	if err := json.Unmarshal([]byte(b6Enforcement(2)), &e); err != nil {
		t.Fatalf("enforcement not valid JSON: %v", err)
	}
	if !e.RequireApproval || !e.RequireVerifyPass {
		t.Fatalf("enforcement must force both gates, got %+v", e)
	}
	if e.MinApprovals != 2 {
		t.Fatalf("min_approvals = %d, want 2", e.MinApprovals)
	}
	// A non-positive min is floored to 1 (the gate engine's Math.max(...,1) invariant).
	if err := json.Unmarshal([]byte(b6Enforcement(0)), &e); err != nil {
		t.Fatalf("enforcement(0) not valid JSON: %v", err)
	}
	if e.MinApprovals != 1 {
		t.Fatalf("min_approvals floored = %d, want 1", e.MinApprovals)
	}
}

func TestB6Truthy(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", "yes", "on", "ON"} {
		if !b6Truthy(v) {
			t.Fatalf("b6Truthy(%q) = false, want true", v)
		}
	}
	for _, v := range []string{"", "0", "false", "no", "off", "maybe"} {
		if b6Truthy(v) {
			t.Fatalf("b6Truthy(%q) = true, want false", v)
		}
	}
}
