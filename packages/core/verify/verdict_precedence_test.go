// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The headline verdict's precedence, pinned branch by branch.
//
// This exists because the precedence had a SECOND, hand-written copy — the E2E receipt gate
// (test/e2e/receipt_evidence.go) re-derived it and carried three of the five branches, never
// consulting not_evaluable. So it computed `pass` for a report that honestly said not_evaluable and
// failed the run: the exact false-PASS rule it was written to enforce, inverted (#2156). The copy is
// gone — both callers now go through VerdictFor — and these cases hold the definition still.
package verify

import "testing"

func TestVerdictForPrecedence(t *testing.T) {
	cases := []struct {
		name    string
		summary Summary
		want    Status
		why     string
	}{
		{
			name:    "a hard fail blocks, whatever else is present",
			summary: Summary{Pass: 9, Fail: 1, Warn: 9, NotEvaluable: 9},
			want:    StatusFail,
			why:     "fail is the only status that stops a real apply, so nothing may outrank it",
		},
		{
			name:    "a warn outranks passes and not_evaluables",
			summary: Summary{Pass: 9, Warn: 1, NotEvaluable: 9},
			want:    StatusWarn,
			why:     "a recorded concern must reach the headline even when most controls passed",
		},
		{
			name:    "one unjudgeable control takes the headline from a clean plan",
			summary: Summary{Pass: 9, NotEvaluable: 1},
			want:    StatusNotEvaluable,
			why:     "THE honesty rule: a pass here would claim we checked something we could not see",
		},
		{
			name:    "not_evaluable alone",
			summary: Summary{NotEvaluable: 1},
			want:    StatusNotEvaluable,
		},
		{
			name:    "only a plan where every in-scope control passed yields pass",
			summary: Summary{Pass: 3},
			want:    StatusPass,
		},
		{
			name:    "an empty tally is not a pass",
			summary: Summary{},
			want:    StatusNotEvaluable,
			why:     "zero controls means nothing was evaluated — the vacuous pass this engine exists to refuse",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := VerdictFor(c.summary); got != c.want {
				t.Fatalf("VerdictFor(%+v) = %q, want %q — %s", c.summary, got, c.want, c.why)
			}
		})
	}
}

// finalize must tally the controls and then defer to VerdictFor — if it grew its own switch again,
// the exported definition would stop being the definition.
func TestFinalizeTalliesAndDefersToVerdictFor(t *testing.T) {
	rep := &Report{Controls: []ControlResult{
		{ID: "A", Status: StatusPass},
		{ID: "B", Status: StatusPass},
		{ID: "C", Status: StatusNotEvaluable},
	}}
	rep.finalize()

	want := Summary{Pass: 2, NotEvaluable: 1}
	if rep.Summary != want {
		t.Fatalf("summary = %+v, want %+v", rep.Summary, want)
	}
	if rep.Verdict != VerdictFor(rep.Summary) {
		t.Fatalf("finalize set verdict %q but the tally %+v rolls up to %q", rep.Verdict, rep.Summary, VerdictFor(rep.Summary))
	}
	if rep.Verdict != StatusNotEvaluable {
		t.Fatalf("verdict = %q, want not_evaluable — a clean plan with one unjudgeable control is not a pass", rep.Verdict)
	}
}

// A not_evaluable headline is honest, not blocking. The two properties are independent and both
// load-bearing: demoting the headline is what stops the false PASS, and NOT blocking on it is what
// stops the gate wedging every apply that has one computed value in it.
func TestNotEvaluableTakesTheHeadlineWithoutBlocking(t *testing.T) {
	rep := &Report{Verdict: VerdictFor(Summary{Pass: 1, NotEvaluable: 1})}
	if rep.Verdict != StatusNotEvaluable {
		t.Fatalf("verdict = %q, want not_evaluable", rep.Verdict)
	}
	if rep.Blocking() {
		t.Fatal("not_evaluable must not block an apply — only a hard fail does")
	}
}
