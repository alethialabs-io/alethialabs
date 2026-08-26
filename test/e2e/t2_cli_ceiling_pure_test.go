// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PURE tests for ceiling satisfaction — no cloud, no network. The DNS branch is driven through the
// lookupNS seam, which is why ci.yml can run this on every PR.
//
// WHAT THESE VARY, AND WHY IT IS THE VALUE AND NOT THE KEY.
//
// The defect this whole file guards against is a probe that reports SATISFIED when it should not,
// because "satisfied" is the direction that turns a red bar green and retires a real requirement.
// Testing that a probe reads variable A rather than variable B would not catch it. What catches it
// is varying the VALUE through every shape the workflow can actually produce — unset, empty,
// whitespace, and in particular the literal string "false", which is exactly what
// `${{ secrets.X != '' }}` renders when the secret is MISSING. A presence check passes that.

// The fixture variables below are deliberately NOT in the `ALETHIA_E2E_*` namespace.
// TestScenarioEnablesReachTheNightly scans that namespace for names the harness reads but the
// nightly never sets — a real guard against shipping a scenario no variable can ever switch on.
// A test fixture is not such a variable, so naming one `ALETHIA_E2E_*` would either red that guard
// or force an exemption entry, and an exemption list padded with fixtures is how a guard stops
// meaning anything. The names the SHIPPING probes read are `ALETHIA_E2E_*` and ARE set by
// e2e-nightly.yml, which is what that guard exists to confirm.
package e2e

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

func TestCeilingEnvProbeVariesOnTheValue(t *testing.T) {
	const name = "CEILING_PROBE_TEST_FLAG"
	probe := &CeilingProbe{Kind: ProbeEnvTruthy, Env: []string{name}, Expect: "set it"}

	cases := []struct {
		value string
		set   bool
		want  bool
		note  string
	}{
		{set: false, want: false, note: "unset"},
		{value: "", set: true, want: false, note: "empty"},
		{value: "   ", set: true, want: false, note: "whitespace"},
		// THE case. GitHub renders a missing secret's presence test as the string "false"; a probe
		// that only checked presence would call this satisfied and silently retire the ceiling.
		{value: "false", set: true, want: false, note: `the literal "false"`},
		{value: "0", set: true, want: false, note: `the literal "0"`},
		{value: "true", set: true, want: true, note: `the literal "true"`},
		{value: "1", set: true, want: true, note: `the literal "1"`},
	}

	for _, tc := range cases {
		t.Run(tc.note, func(t *testing.T) {
			if tc.set {
				t.Setenv(name, tc.value)
			} else {
				t.Setenv(name, "")
			}
			got, evidence := probe.Evaluate(context.Background())
			if got != tc.want {
				t.Errorf("value %q (%s): satisfied=%v want %v — evidence %q", tc.value, tc.note, got, tc.want, evidence)
			}
			if evidence == "" {
				t.Error("a probe must always say what it read; a bare boolean is not actionable in a proof bundle")
			}
		})
	}
}

// Every named variable must be truthy. One set and one missing must NOT satisfy — a partially
// configured ceiling is not a satisfied one, and an `any` here would be the leak.
func TestCeilingEnvProbeRequiresEveryVariable(t *testing.T) {
	probe := &CeilingProbe{
		Kind:   ProbeEnvTruthy,
		Env:    []string{"CEILING_PROBE_TEST_A", "CEILING_PROBE_TEST_B"},
		Expect: "set both",
	}
	t.Setenv("CEILING_PROBE_TEST_A", "true")
	t.Setenv("CEILING_PROBE_TEST_B", "")
	if ok, evidence := probe.Evaluate(context.Background()); ok {
		t.Fatalf("one of two variables satisfied the probe: %s", evidence)
	}
	t.Setenv("CEILING_PROBE_TEST_B", "true")
	if ok, evidence := probe.Evaluate(context.Background()); !ok {
		t.Fatalf("both variables set and the probe is still unsatisfied: %s", evidence)
	}
}

func TestCeilingZoneProbeFailsClosed(t *testing.T) {
	const name = "CEILING_PROBE_TEST_ZONE"
	probe := &CeilingProbe{Kind: ProbeZoneDelegated, Env: []string{name}, Expect: "delegate it"}

	cases := []struct {
		note   string
		zone   string
		ns     []*net.NS
		err    error
		want   bool
		expect string
	}{
		{note: "zone variable unset", zone: "", want: false},
		{note: "zone variable is whitespace", zone: "   ", want: false},
		// A hosted zone that exists but that nothing delegates to answers EMPTY. This is the exact
		// state #1773 described, and it is the one an over-eager probe would call success.
		{note: "no authoritative name servers", zone: "e2e.example.test", ns: nil, want: false},
		{note: "resolver error", zone: "e2e.example.test", err: errors.New("SERVFAIL"), want: false},
		{note: "delegated", zone: "e2e.example.test", ns: []*net.NS{{Host: "ns-1.awsdns-00.com."}}, want: true, expect: "ns-1.awsdns-00.com"},
	}

	for _, tc := range cases {
		t.Run(tc.note, func(t *testing.T) {
			t.Setenv(name, tc.zone)
			original := lookupNS
			t.Cleanup(func() { lookupNS = original })
			lookupNS = func(context.Context, string) ([]*net.NS, error) { return tc.ns, tc.err }

			got, evidence := probe.Evaluate(context.Background())
			if got != tc.want {
				t.Fatalf("satisfied=%v want %v — evidence %q", got, tc.want, evidence)
			}
			// The trailing dot must be stripped, or the evidence line reads like a bug report.
			if tc.expect != "" && !strings.Contains(evidence, tc.expect) {
				t.Errorf("evidence %q does not name the name server %q", evidence, tc.expect)
			}
		})
	}
}

// A probe whose Kind is not one this file implements must never satisfy. The default branch is
// where a typo would otherwise land, and a typo that reads as SATISFIED retires a real ceiling.
func TestCeilingUnknownKindNeverSatisfies(t *testing.T) {
	probe := &CeilingProbe{Kind: CeilingProbeKind("looks-fine"), Env: []string{"X"}, Expect: "x"}
	if ok, _ := probe.Evaluate(context.Background()); ok {
		t.Fatal("an unknown probe kind reported SATISFIED")
	}
	var nilProbe *CeilingProbe
	if ok, _ := nilProbe.Evaluate(context.Background()); ok {
		t.Fatal("a nil probe reported SATISFIED")
	}
}

// EvaluateCeilings must move satisfied ceilings OUT of Manual and leave the rest — with the reading
// attached, so an outstanding ceiling says why it is outstanding.
func TestEvaluateCeilingsPartitionsAndExplains(t *testing.T) {
	done := DemoStep{
		ID: "done", Title: "done", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50),
		SatisfiedBy: &CeilingProbe{Kind: ProbeEnvTruthy, Env: []string{"CEILING_PROBE_TEST_DONE"}, Expect: "set it"},
	}
	outstanding := DemoStep{
		ID: "outstanding", Title: "outstanding", Reach: CloudManual, Issue: "#2", Why: strings.Repeat("w", 50),
		SatisfiedBy: &CeilingProbe{Kind: ProbeEnvTruthy, Env: []string{"CEILING_PROBE_TEST_OUTSTANDING"}, Expect: "do the thing"},
	}
	t.Setenv("CEILING_PROBE_TEST_DONE", "true")
	t.Setenv("CEILING_PROBE_TEST_OUTSTANDING", "false")

	in := CLIDemoProof{Cloud: "aws", Driven: []string{"login"}, Manual: []DemoStep{done, outstanding}}
	if in.Passed() {
		t.Fatal("the unevaluated control passes, so the assertion below proves nothing")
	}

	out := in.EvaluateCeilings(context.Background())
	if len(out.Satisfied) != 1 || out.Satisfied[0].Step.ID != "done" {
		t.Fatalf("satisfied = %+v, want exactly the 'done' ceiling", out.Satisfied)
	}
	if len(out.Manual) != 1 || out.Manual[0].ID != "outstanding" {
		t.Fatalf("manual = %+v, want exactly the 'outstanding' ceiling", out.Manual)
	}
	if out.Manual[0].ProbeReading == "" {
		t.Error("an outstanding ceiling must carry what the probe READ — 'not done' and 'could not tell' need different remedies")
	}
	if out.Passed() {
		t.Error("one ceiling is still outstanding and the bar passed")
	}

	// And the whole point: with both satisfied, the bar passes — while still PRINTING both.
	t.Setenv("CEILING_PROBE_TEST_OUTSTANDING", "true")
	both := in.EvaluateCeilings(context.Background())
	if !both.Passed() {
		t.Fatalf("every ceiling is satisfied and the bar still fails: %s", both.Verdict())
	}
	if !strings.Contains(both.Verdict(), "ceiling") {
		t.Errorf("a PASS that omits the ceilings reads as 'this cloud has none': %q", both.Verdict())
	}
	summary := both.Summary()
	for _, id := range []string{"done", "outstanding"} {
		if !strings.Contains(summary, id) {
			t.Errorf("summary drops satisfied ceiling %q — a prospect deserves to know the manual step exists", id)
		}
	}
}

// Every ceiling in the SHIPPING table must carry a probe that is well-formed. This is the row-level
// counterpart to the mutation gate: the gate proves the rule discriminates, this proves the real
// table obeys it.
func TestEveryShippedCeilingCarriesAProbe(t *testing.T) {
	ceilings := 0
	for _, s := range CLIDemoSteps {
		if s.Reach != CloudManual {
			continue
		}
		ceilings++
		if err := s.SatisfiedBy.Validate(s.ID); err != nil {
			t.Errorf("shipped ceiling %q: %v", s.ID, err)
		}
	}
	if ceilings == 0 {
		t.Fatal("the table carries no ceilings at all, so this test asserted nothing")
	}
}
