// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PURE day-2 ACCESS helpers (FULLY-TESTED P2-E) — no cloud, no token, no
// e2e_t2 tag. These prove each check's decision is non-vacuous: the target derivation
// HARD-FAILS when no access path was surfaced (the refuter for a vacuous access proof), the
// auth classifier distinguishes authorized / reachable-but-401 / unreachable, and the verdict
// only reads green when every check that ran actually passed.
package e2e

import (
	"strings"
	"testing"
	"time"
)

func TestDeriveAccessTargets(t *testing.T) {
	// AWS-shaped: both endpoint and argocd_url surfaced.
	tgt, err := deriveAccessTargets([]byte(`{"cluster_endpoint":"https://abc.eks.amazonaws.com","argocd_url":"https://argocd.prod.example.com"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tgt.Endpoint != "https://abc.eks.amazonaws.com" || !tgt.HasArgoURL || tgt.ArgoURL != "https://argocd.prod.example.com" {
		t.Fatalf("parsed targets = %+v", tgt)
	}

	// gcp/azure-shaped: endpoint surfaced, NO ingress ⇒ no argocd_url.
	tgt2, err := deriveAccessTargets([]byte(`{"cluster_endpoint":"https://1.2.3.4","argocd_url":""}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tgt2.Endpoint != "https://1.2.3.4" || tgt2.HasArgoURL || tgt2.ArgoURL != "" {
		t.Fatalf("no-ingress targets = %+v (want endpoint set, HasArgoURL=false)", tgt2)
	}

	// Fail-closed refuters — each MUST error (a deploy that surfaced no access path can't be
	// asserted vacuously).
	refuters := []struct {
		name string
		raw  string
	}{
		{"empty metadata", ``},
		{"empty object", `{}`},
		{"blank endpoint", `{"cluster_endpoint":"   ","argocd_url":"https://x"}`},
		{"missing endpoint key", `{"argocd_url":"https://x"}`},
		{"malformed json", `{cluster_endpoint`},
	}
	for _, r := range refuters {
		t.Run(r.name, func(t *testing.T) {
			if _, err := deriveAccessTargets([]byte(r.raw)); err == nil {
				t.Fatalf("expected a HARD FAIL for %q — the access assertion would be vacuous", r.name)
			}
		})
	}
}

func TestAccessVerdictPass(t *testing.T) {
	green := AccessSummary{
		Enabled: true, EndpointSurfaced: true, KubeReachable: true, KubeAuthorized: true,
		ReadyNodes: 2, ArgoURLChecked: true, ArgoURLReachable: true,
	}
	if !accessVerdictPass(green) {
		t.Fatal("fully-green summary should pass")
	}
	// Each individual failing condition must flip the verdict red.
	flips := map[string]func(*AccessSummary){
		"disabled":               func(s *AccessSummary) { s.Enabled = false },
		"endpoint not surfaced":  func(s *AccessSummary) { s.EndpointSurfaced = false },
		"kube not reachable":     func(s *AccessSummary) { s.KubeReachable = false },
		"kube not authorized":    func(s *AccessSummary) { s.KubeAuthorized = false },
		"zero ready nodes":       func(s *AccessSummary) { s.ReadyNodes = 0 },
		"argocd url unreachable": func(s *AccessSummary) { s.ArgoURLReachable = false },
	}
	for name, mut := range flips {
		t.Run(name, func(t *testing.T) {
			s := green
			mut(&s)
			if accessVerdictPass(s) {
				t.Fatalf("%q should make the verdict fail", name)
			}
		})
	}
	// When the ArgoCD-URL check did NOT run (gcp/azure — no ingress), it does not gate.
	noArgo := green
	noArgo.ArgoURLChecked = false
	noArgo.ArgoURLReachable = false
	if !accessVerdictPass(noArgo) {
		t.Fatal("with ArgoURLChecked=false the argocd-url fields must not gate the verdict")
	}
}

func TestParseAuthCanI(t *testing.T) {
	for _, ok := range []string{"yes", "YES", "  yes\n", "Yes"} {
		if !parseAuthCanI(ok) {
			t.Errorf("parseAuthCanI(%q) = false, want true", ok)
		}
	}
	for _, no := range []string{"no", "NO", "", "   ", "maybe", "yesish", "yes no"} {
		if parseAuthCanI(no) {
			t.Errorf("parseAuthCanI(%q) = true, want false", no)
		}
	}
}

func TestClassifyCanI(t *testing.T) {
	tests := []struct {
		name          string
		out           string
		wantReachable bool
		wantAuthd     bool
	}{
		{"authorized", "yes\n", true, true},
		{"reachable but denied", "no\n", true, false},
		{"reachable but 401", "error: You must be logged in to the server (Unauthorized)", true, false},
		{"reachable but forbidden", "Error from server (Forbidden): ...", true, false},
		{"unreachable dial", "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout", false, false},
		{"unreachable dns", "Unable to connect to the server: dial tcp: lookup x: no such host", false, false},
		{"unreachable refused", "The connection to the server was refused - connection refused", false, false},
		{"empty output", "", false, false},
		{"unknown garbage", "wat", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, a := classifyCanI(tt.out)
			if r != tt.wantReachable || a != tt.wantAuthd {
				t.Fatalf("classifyCanI(%q) = (reachable=%t, authorized=%t), want (%t, %t)", tt.out, r, a, tt.wantReachable, tt.wantAuthd)
			}
		})
	}
}

func TestCountReadyNodeLines(t *testing.T) {
	out := "ip-10-0-1-5   Ready    <none>   3m   v1.32\n" +
		"ip-10-0-1-6   Ready    <none>   3m   v1.32\n" +
		"ip-10-0-1-7   NotReady <none>   1m   v1.32\n"
	if n := countReadyNodeLines(out); n != 2 {
		t.Fatalf("countReadyNodeLines = %d, want 2", n)
	}
	if n := countReadyNodeLines(""); n != 0 {
		t.Fatalf("countReadyNodeLines(empty) = %d, want 0", n)
	}
	if n := countReadyNodeLines("node-a   NotReady   <none>   1m   v1.32"); n != 0 {
		t.Fatalf("countReadyNodeLines(all NotReady) = %d, want 0", n)
	}
}

func TestEvaluateArgoURLStatus(t *testing.T) {
	for _, code := range []int{200, 301, 302, 307, 308} {
		if err := evaluateArgoURLStatus(code); err != nil {
			t.Errorf("evaluateArgoURLStatus(%d) = %v, want nil (resolvable)", code, err)
		}
	}
	for _, code := range []int{400, 404, 500, 502, 503} {
		if err := evaluateArgoURLStatus(code); err == nil {
			t.Errorf("evaluateArgoURLStatus(%d) = nil, want error", code)
		}
	}
}

func TestAccessSummaryVerdict(t *testing.T) {
	if got := accessSummaryVerdict(AccessSummary{Enabled: false}); !strings.Contains(got, "skipped") {
		t.Fatalf("disabled verdict = %q, want a skip line", got)
	}
	// gcp/azure (no ingress): renders n/a for the argocd-url, still green on the rest.
	gcp := AccessSummary{
		Enabled: true, Provider: "gcp", EndpointSurfaced: true, KubeReachable: true,
		KubeAuthorized: true, ReadyNodes: 3, ArgoURLChecked: false,
	}
	v := accessSummaryVerdict(gcp)
	if !strings.Contains(v, "n/a") || !strings.Contains(v, "✅") {
		t.Fatalf("gcp verdict = %q, want an ✅ line with argocd-url n/a", v)
	}
	// A red summary renders ❌.
	red := gcp
	red.KubeAuthorized = false
	if !strings.Contains(accessSummaryVerdict(red), "❌") {
		t.Fatalf("unauthorized verdict should render ❌: %q", accessSummaryVerdict(red))
	}
}

func TestDay2AccessTimeout(t *testing.T) {
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT", "")
	if d := Day2AccessTimeout(); d != 3*time.Minute {
		t.Fatalf("default timeout = %v, want 3m", d)
	}
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT", "90s")
	if d := Day2AccessTimeout(); d != 90*time.Second {
		t.Fatalf("override timeout = %v, want 90s", d)
	}
	// A garbage / non-positive value falls back to the default (never a zero-timeout probe).
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT", "soon")
	if d := Day2AccessTimeout(); d != 3*time.Minute {
		t.Fatalf("garbage timeout = %v, want the 3m default", d)
	}
}
