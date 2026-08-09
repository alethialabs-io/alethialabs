// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	tfjson "github.com/hashicorp/terraform-json"
)

// ── the fail-closed backstops ───────────────────────────────────────────

// TestOverrideCovers pins the waiver rules, including the one that protects the
// gate's own backstop: GATE-PLAN-UNAVAILABLE may be waived ONLY by an override with
// an explicit, unexpired Expiry, so a payload that merely omits `expiry` cannot
// disable the missing-plan-JSON refusal forever.
func TestOverrideCovers(t *testing.T) {
	future := time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)
	past := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		ov   *Override
		id   string
		want bool
	}{
		{"nil override waives nothing", nil, "LEASTPRIV-001", false},
		{"regular control, no expiry", &Override{Controls: []string{"LEASTPRIV-001"}}, "LEASTPRIV-001", true},
		{"regular control, unexpired", &Override{Controls: []string{"LEASTPRIV-001"}, Expiry: future}, "LEASTPRIV-001", true},
		{"regular control, expired", &Override{Controls: []string{"LEASTPRIV-001"}, Expiry: past}, "LEASTPRIV-001", false},
		{"control not listed", &Override{Controls: []string{"KEYLESS-001"}, Expiry: future}, "LEASTPRIV-001", false},
		{"backstop needs an expiry", &Override{Controls: []string{ControlPlanUnavailable}}, ControlPlanUnavailable, false},
		{"backstop with an expiry", &Override{Controls: []string{ControlPlanUnavailable}, Expiry: future}, ControlPlanUnavailable, true},
		{"backstop expired", &Override{Controls: []string{ControlPlanUnavailable}, Expiry: past}, ControlPlanUnavailable, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.ov.Covers(tc.id); got != tc.want {
				t.Errorf("Covers(%q) = %v, want %v", tc.id, got, tc.want)
			}
		})
	}
}

// TestUnwaivedIgnoresNonFailStatuses proves the apply gate blocks on hard fails only
// and that a waiver removes exactly the listed control.
func TestUnwaivedIgnoresNonFailStatuses(t *testing.T) {
	rep := &Report{Controls: []ControlResult{
		{ID: "KEYLESS-001", Status: StatusFail},
		{ID: "LEASTPRIV-001", Status: StatusFail},
		{ID: "OIDC-001", Status: StatusWarn},
		{ID: "SCOPE-001", Status: StatusNotEvaluable},
		{ID: "GCP-WIF-001", Status: StatusPass},
	}}
	if got := rep.Unwaived(nil); len(got) != 2 || got[0] != "KEYLESS-001" || got[1] != "LEASTPRIV-001" {
		t.Fatalf("Unwaived(nil) = %v, want the two failing controls in plan order", got)
	}
	ov := &Override{Controls: []string{"KEYLESS-001"}, Expiry: time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)}
	if got := rep.Unwaived(ov); len(got) != 1 || got[0] != "LEASTPRIV-001" {
		t.Fatalf("Unwaived(override) = %v, want only LEASTPRIV-001", got)
	}
}

// ── the bounded remediation loop ────────────────────────────────────────

// stubRemediator returns the queued plans in order, then nil (giving up). It records
// the verdict it was handed on each round so the loop's feedback wiring is checked.
type stubRemediator struct {
	plans    []*tfjson.Plan
	calls    int
	verdicts []Status
}

// Attempt hands back the next queued plan for the 1-based attempt number.
func (s *stubRemediator) Attempt(_ context.Context, current *Report, attempt int) (*tfjson.Plan, error) {
	s.calls++
	s.verdicts = append(s.verdicts, current.Verdict)
	if attempt-1 >= len(s.plans) {
		return nil, nil
	}
	return s.plans[attempt-1], nil
}

// failingPlan is a plan whose only resource is a static IAM access key (KEYLESS-001).
func failingPlan() *tfjson.Plan {
	return &tfjson.Plan{ResourceChanges: []*tfjson.ResourceChange{{
		Address: "aws_iam_access_key.k", Type: "aws_iam_access_key", Mode: tfjson.ManagedResourceMode,
		Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionCreate}, After: map[string]any{"user": "u"}},
	}}}
}

// cleanPlan is the same plan with the static key removed.
func cleanPlan() *tfjson.Plan {
	return &tfjson.Plan{ResourceChanges: []*tfjson.ResourceChange{{
		Address: "aws_iam_role.r", Type: "aws_iam_role", Mode: tfjson.ManagedResourceMode,
		Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionCreate}, After: map[string]any{
			"assume_role_policy": `{"Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}`,
		}},
	}}}
}

// TestRunRemediationLoopBounds pins the loop's control flow: a non-positive attempt
// budget still runs exactly one round, a nil candidate ends the loop without
// acceptance, and acceptance stops the loop immediately.
func TestRunRemediationLoopBounds(t *testing.T) {
	ctx := context.Background()
	original, err := Evaluate(ctx, failingPlan())
	if err != nil {
		t.Fatal(err)
	}
	if !original.Blocking() {
		t.Fatalf("fixture plan is not blocking (verdict %q) — the loop has nothing to remediate", original.Verdict)
	}

	t.Run("non-positive budget runs one attempt", func(t *testing.T) {
		rem := &stubRemediator{plans: []*tfjson.Plan{failingPlan(), cleanPlan()}}
		out, err := RunRemediationLoop(ctx, original, rem, 0)
		if err != nil {
			t.Fatal(err)
		}
		if rem.calls != 1 {
			t.Errorf("remediator called %d times, want 1 (maxAttempts<1 is clamped to 1)", rem.calls)
		}
		if out.Succeeded || out.Attempts != 1 {
			t.Errorf("outcome = %+v, want succeeded=false attempts=1", out)
		}
	})

	t.Run("nil candidate gives up without acceptance", func(t *testing.T) {
		rem := &stubRemediator{} // first Attempt already returns nil
		out, err := RunRemediationLoop(ctx, original, rem, 3)
		if err != nil {
			t.Fatal(err)
		}
		if out.Succeeded || out.Attempts != 0 || out.Final != nil {
			t.Errorf("outcome = %+v, want an empty, unsuccessful outcome", out)
		}
	})

	t.Run("accepts as soon as the gate confirms the fix", func(t *testing.T) {
		rem := &stubRemediator{plans: []*tfjson.Plan{failingPlan(), cleanPlan(), cleanPlan()}}
		out, err := RunRemediationLoop(ctx, original, rem, 5)
		if err != nil {
			t.Fatal(err)
		}
		if !out.Succeeded || out.Attempts != 2 {
			t.Fatalf("outcome = %+v, want succeeded=true attempts=2", out)
		}
		if rem.calls != 2 {
			t.Errorf("remediator called %d times, want 2 (the loop stops on acceptance)", rem.calls)
		}
		if len(out.Final.Resolved) != 1 || out.Final.Resolved[0] != "KEYLESS-001" {
			t.Errorf("resolved = %v, want [KEYLESS-001]", out.Final.Resolved)
		}
	})
}

// TestReVerifyWithNoOriginalReport: with no original report every candidate failure
// is NEWLY failing, so the candidate is refused rather than waved through.
func TestReVerifyWithNoOriginalReport(t *testing.T) {
	res, err := ReVerify(context.Background(), nil, failingPlan())
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted {
		t.Fatal("a candidate that fails KEYLESS-001 was accepted against a nil original report")
	}
	if len(res.NewlyFailing) != 1 || res.NewlyFailing[0] != "KEYLESS-001" {
		t.Errorf("newly failing = %v, want [KEYLESS-001]", res.NewlyFailing)
	}
}

// ── the Rekor inclusion-proof arithmetic ────────────────────────────────

// TestVerifyInclusionRFC6962 walks a fixed 4-leaf Merkle tree, proving both audit
// path orientations (the leaf as the RIGHT child at the bottom level) and the
// refusals: an out-of-range index, a non-hex hash, a wrong-length hash, a proof of
// the wrong depth, and a root that does not match.
func TestVerifyInclusionRFC6962(t *testing.T) {
	leaves := make([][]byte, 4)
	for i := range leaves {
		leaves[i] = rfc6962LeafHash([]byte{byte('a' + i)})
	}
	left := rfc6962NodeHash(leaves[0], leaves[1])
	right := rfc6962NodeHash(leaves[2], leaves[3])
	root := rfc6962NodeHash(left, right)
	hx := func(b []byte) string { return hex.EncodeToString(b) }

	t.Run("leaf 1 is a right child", func(t *testing.T) {
		if err := verifyInclusion(1, 4, leaves[1], []string{hx(leaves[0]), hx(right)}, root); err != nil {
			t.Fatalf("valid inclusion proof rejected: %v", err)
		}
	})
	t.Run("leaf 2 is a left child", func(t *testing.T) {
		if err := verifyInclusion(2, 4, leaves[2], []string{hx(leaves[3]), hx(left)}, root); err != nil {
			t.Fatalf("valid inclusion proof rejected: %v", err)
		}
	})

	bad := []struct {
		name    string
		index   int64
		size    int64
		hashes  []string
		root    []byte
		wantSub string
	}{
		{"negative index", -1, 4, []string{hx(leaves[0]), hx(right)}, root, "negative index"},
		{"index past the tree", 4, 4, []string{hx(leaves[0]), hx(right)}, root, "out of range"},
		{"non-hex audit hash", 1, 4, []string{"zz", hx(right)}, root, "decode audit hash"},
		{"short audit hash", 1, 4, []string{"ab", hx(right)}, root, "want 32"},
		{"wrong proof length", 1, 4, []string{hx(leaves[0])}, root, "want 2"},
		{"wrong root", 1, 4, []string{hx(leaves[0]), hx(right)}, leaves[0], "does not match claimed root"},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyInclusion(tc.index, tc.size, leaves[1], tc.hashes, tc.root)
			if err == nil {
				t.Fatalf("verifyInclusion accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Errorf("error %q does not mention %q", err, tc.wantSub)
			}
		})
	}
}

// ── the Hetzner exposure control's plan shapes ──────────────────────────

// hcloudFirewall builds a planned hcloud_firewall from its rule list + after_unknown.
func hcloudFirewall(addr string, rules []any, afterUnknown any) plannedResource {
	after := map[string]any{}
	if rules != nil {
		after["rule"] = rules
	}
	return plannedResource{address: addr, rtype: "hcloud_firewall", after: after, afterUnknown: afterUnknown}
}

// inRule builds an inbound firewall rule value.
func inRule(proto, port string, sources ...string) map[string]any {
	src := make([]any, 0, len(sources))
	for _, s := range sources {
		src = append(src, s)
	}
	return map[string]any{"direction": "in", "protocol": proto, "port": port, "source_ips": src}
}

// TestHCloudFirewallExposureShapes covers HCLOUD-NET-001's non-headline arms: a
// wholly-computed rule list, a per-rule computed field, an egress-only firewall, a
// non-object rule entry, and the very-broad-source SSH warn backstop.
func TestHCloudFirewallExposureShapes(t *testing.T) {
	cases := []struct {
		name       string
		res        plannedResource
		wantStatus Status
		wantCovSub string
		wantMsgSub string
	}{
		{
			name:       "whole rule list computed until apply",
			res:        hcloudFirewall("hcloud_firewall.a", nil, map[string]any{"rule": true}),
			wantStatus: StatusNotEvaluable,
			wantCovSub: "firewall rules not known until apply",
		},
		{
			name: "one rule's source computed until apply",
			res: hcloudFirewall("hcloud_firewall.b",
				[]any{inRule("tcp", "22", "0.0.0.0/0")},
				map[string]any{"rule": []any{map[string]any{"source_ips": []any{true}}}}),
			wantStatus: StatusNotEvaluable,
			wantCovSub: "source/port not known until apply",
		},
		{
			name: "egress rules are out of scope",
			res: hcloudFirewall("hcloud_firewall.c",
				[]any{map[string]any{"direction": "out", "protocol": "tcp", "port": "22", "source_ips": []any{"0.0.0.0/0"}}},
				nil),
			wantStatus: StatusPass,
			wantCovSub: "no resources in scope",
		},
		{
			name:       "non-object rule entries are skipped",
			res:        hcloudFirewall("hcloud_firewall.d", []any{"not-a-rule", 42}, nil),
			wantStatus: StatusPass,
			wantCovSub: "no resources in scope",
		},
		{
			name:       "very broad but not world-open SSH warns",
			res:        hcloudFirewall("hcloud_firewall.e", []any{inRule("tcp", "22", "10.0.0.0/8")}, nil),
			wantStatus: StatusWarn,
			wantMsgSub: "very broad source range",
		},
		{
			name:       "world-open SSH hard-fails",
			res:        hcloudFirewall("hcloud_firewall.f", []any{inRule("tcp", "22", "0.0.0.0/0")}, nil),
			wantStatus: StatusFail,
			wantMsgSub: "world-open SSH",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := controlHCloudFirewallExposure([]plannedResource{tc.res})
			if c.Status != tc.wantStatus {
				t.Fatalf("HCLOUD-NET-001 = %q, want %q (coverage %q, findings %+v)", c.Status, tc.wantStatus, c.Coverage, c.Findings)
			}
			if tc.wantCovSub != "" && !strings.Contains(c.Coverage, tc.wantCovSub) {
				t.Errorf("coverage %q does not mention %q", c.Coverage, tc.wantCovSub)
			}
			if tc.wantMsgSub != "" {
				joined := ""
				for _, f := range c.Findings {
					joined += f.Message + "\n"
				}
				if !strings.Contains(joined, tc.wantMsgSub) {
					t.Errorf("findings %q do not mention %q", joined, tc.wantMsgSub)
				}
			}
		})
	}
}

// TestCoversWholeInternetUnion pins the union judgment, including the duplicated
// 0.0.0.0/0 spelling that sweeps past the last address before the range list is
// exhausted.
func TestCoversWholeInternetUnion(t *testing.T) {
	cases := []struct {
		name    string
		sources []string
		want    bool
	}{
		{"empty", nil, false},
		{"single v4 world", []string{"0.0.0.0/0"}, true},
		{"single v6 world", []string{"::/0"}, true},
		{"duplicated world", []string{"0.0.0.0/0", "0.0.0.0/0"}, true},
		{"world plus a redundant subnet", []string{"0.0.0.0/0", "10.0.0.0/8"}, true},
		{"split halves", []string{"0.0.0.0/1", "128.0.0.0/1"}, true},
		{"split halves with a gap", []string{"0.0.0.0/2", "128.0.0.0/1"}, false},
		{"unparseable entries prove nothing", []string{"not-a-cidr", "10.0.0.0/8"}, false},
		{"broad but partial", []string{"10.0.0.0/8"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := coversWholeInternet(tc.sources); got != tc.want {
				t.Errorf("coversWholeInternet(%v) = %v, want %v", tc.sources, got, tc.want)
			}
		})
	}
}

// ── the k8s container-security warn arm ─────────────────────────────────

// TestContainerSecurityWarnsWhenRunAsNonRootUnset: a pinned, non-privileged, non-root
// container that never declares runAsNonRoot is a recorded WARN — it may still run as
// root — rather than a silent pass.
func TestContainerSecurityWarnsWhenRunAsNonRootUnset(t *testing.T) {
	const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: unset
spec:
  template:
    spec:
      containers:
        - name: app
          image: reg.example.com/app:v1.2.3
`
	rep, err := EvaluateManifests([]byte(manifest))
	if err != nil {
		t.Fatal(err)
	}
	c := controlByID(t, rep, "CONTAINERSECURITY-001")
	if c.Status != StatusWarn {
		t.Fatalf("CONTAINERSECURITY-001 = %q, want warn (findings %+v)", c.Status, c.Findings)
	}
	if len(c.Findings) != 1 || !strings.Contains(c.Findings[0].Message, "does not set runAsNonRoot") {
		t.Errorf("findings = %+v, want a single runAsNonRoot warning", c.Findings)
	}
	if rep.Verdict != StatusWarn || rep.Blocking() {
		t.Errorf("verdict = %q blocking = %v, want warn / non-blocking", rep.Verdict, rep.Blocking())
	}
}
