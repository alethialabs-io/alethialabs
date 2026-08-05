// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat

import (
	"testing"
)

// TestParseMinor pins the Kubernetes version parser, including every rejection
// the honesty rule depends on: an unparseable version must yield ok=false so the
// caller reports not_evaluable rather than comparing against a zero value (which
// would silently pass every lower bound).
func TestParseMinor(t *testing.T) {
	cases := []struct {
		in      string
		wantOK  bool
		wantMaj int
		wantMin int
	}{
		{in: "1.35", wantOK: true, wantMaj: 1, wantMin: 35},
		{in: "1.35.6", wantOK: true, wantMaj: 1, wantMin: 35},
		{in: "v1.35", wantOK: true, wantMaj: 1, wantMin: 35},
		{in: "  v 1.35  ", wantOK: true, wantMaj: 1, wantMin: 35},
		{in: "2.0", wantOK: true, wantMaj: 2, wantMin: 0},
		{in: ""},
		{in: "   "},
		{in: "v"},
		{in: "1"},
		{in: "latest"},
		{in: "x.35"},
		{in: "1.y"},
		{in: "1.35-rc1"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := parseMinor(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("parseMinor(%q) ok = %v, want %v", tc.in, ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if got.major != tc.wantMaj || got.min != tc.wantMin {
				t.Errorf("parseMinor(%q) = %d.%d, want %d.%d", tc.in, got.major, got.min, tc.wantMaj, tc.wantMin)
			}
		})
	}
}

// TestCmpMinor pins the ordering, including the major-version legs a
// minor-only comparison would get wrong (2.0 must sort above 1.99).
func TestCmpMinor(t *testing.T) {
	cases := []struct {
		name string
		a, b minor
		want int
	}{
		{name: "equal", a: minor{1, 35}, b: minor{1, 35}, want: 0},
		{name: "lower minor", a: minor{1, 33}, b: minor{1, 35}, want: -1},
		{name: "higher minor", a: minor{1, 36}, b: minor{1, 35}, want: 1},
		{name: "lower major", a: minor{1, 99}, b: minor{2, 0}, want: -1},
		{name: "higher major", a: minor{2, 0}, b: minor{1, 99}, want: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cmpMinor(tc.a, tc.b); got != tc.want {
				t.Errorf("cmpMinor(%+v, %+v) = %d, want %d", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

// TestRangeLabel pins every window rendering the fail message can produce.
func TestRangeLabel(t *testing.T) {
	cases := []struct {
		min, max string
		want     string
	}{
		{min: "1.34", max: "1.36", want: "1.34–1.36"},
		{min: "1.33", max: "", want: "1.33+"},
		{min: "", max: "1.32", want: "≤1.32"},
		{min: "", max: "", want: "any"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			if got := rangeLabel(tc.min, tc.max); got != tc.want {
				t.Errorf("rangeLabel(%q, %q) = %q, want %q", tc.min, tc.max, got, tc.want)
			}
		})
	}
}

// TestCheckK8sRange pins the cardinal rule: every input the matrix cannot judge
// — no window recorded, an unparseable cluster version, an unparseable recorded
// bound — must return not_evaluable with a plain-language note, never a pass.
func TestCheckK8sRange(t *testing.T) {
	cases := []struct {
		name          string
		k8s, min, max string
		want          Status
		wantDetail    string
	}{
		{
			name: "no window recorded", k8s: "1.35",
			want: StatusNotEvaluable, wantDetail: "no Kubernetes compatibility range recorded",
		},
		{
			name: "cluster version unparseable", k8s: "latest", min: "1.33",
			want: StatusNotEvaluable, wantDetail: "cluster Kubernetes version is unset or unparseable",
		},
		{
			name: "cluster version unset", min: "1.33",
			want: StatusNotEvaluable, wantDetail: "cluster Kubernetes version is unset or unparseable",
		},
		{
			name: "lower bound unparseable", k8s: "1.35", min: "oldest",
			want: StatusNotEvaluable, wantDetail: `recorded lower bound "oldest" is unparseable`,
		},
		{
			name: "upper bound unparseable", k8s: "1.35", min: "1.30", max: "newest",
			want: StatusNotEvaluable, wantDetail: `recorded upper bound "newest" is unparseable`,
		},
		{name: "below lower bound", k8s: "1.30", min: "1.33", want: StatusFail},
		{name: "above upper bound", k8s: "1.40", max: "1.36", want: StatusFail},
		{name: "on the lower bound", k8s: "1.33", min: "1.33", want: StatusPass},
		{name: "on the upper bound", k8s: "1.36", max: "1.36", want: StatusPass},
		{name: "inside the window", k8s: "1.35", min: "1.33", max: "1.36", want: StatusPass},
		{name: "unbounded above", k8s: "9.9", min: "1.33", want: StatusPass},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, detail := checkK8sRange(tc.k8s, tc.min, tc.max)
			if got != tc.want {
				t.Errorf("status = %q, want %q (detail %q)", got, tc.want, detail)
			}
			if detail != tc.wantDetail {
				t.Errorf("detail = %q, want %q", detail, tc.wantDetail)
			}
		})
	}
}

// TestEvaluateNotEvaluableSubjects asserts the engine reports not_evaluable —
// and therefore does NOT block — for subjects the embedded matrix has no data
// for, instead of the vacuous pass a "no known problem" engine would emit.
func TestEvaluateNotEvaluableSubjects(t *testing.T) {
	cases := []struct {
		name        string
		subject     Subject
		wantID      string
		wantCovNote string
	}{
		{
			name:        "unknown cloud",
			subject:     Subject{Providers: []string{"nimbus"}, K8sVersion: "1.35"},
			wantID:      "COMPAT-K8S-CLOUD-NIMBUS",
			wantCovNote: `no supported Kubernetes versions recorded for cloud "nimbus"`,
		},
		{
			name:        "known cloud, unparseable cluster version",
			subject:     Subject{Providers: []string{"aws"}, K8sVersion: "latest"},
			wantID:      "COMPAT-K8S-CLOUD-AWS",
			wantCovNote: "cluster Kubernetes version is unset or unparseable",
		},
		{
			name: "component version not recorded",
			subject: Subject{
				K8sVersion: "1.35",
				Components: []ComponentRef{{ID: "argocd", Version: "0.0.0-nope"}},
			},
			wantID:      "COMPAT-COMPONENT-ARGOCD",
			wantCovNote: "no compatibility data recorded for argocd 0.0.0-nope",
		},
		{
			name: "add-on not in the matrix",
			subject: Subject{
				K8sVersion: "1.35",
				AddOns:     []AddOnRef{{ID: "not-an-addon"}},
			},
			wantID:      "COMPAT-ADDON-NOT-AN-ADDON",
			wantCovNote: `add-on "not-an-addon" is not in the compatibility matrix`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep := Evaluate(tc.subject)
			if len(rep.Controls) != 1 {
				t.Fatalf("controls = %+v, want exactly one", rep.Controls)
			}
			c := rep.Controls[0]
			if c.ID != tc.wantID {
				t.Errorf("control id = %q, want %q", c.ID, tc.wantID)
			}
			if c.Status != StatusNotEvaluable {
				t.Errorf("status = %q, want %q", c.Status, StatusNotEvaluable)
			}
			if c.Coverage != tc.wantCovNote {
				t.Errorf("coverage = %q, want %q", c.Coverage, tc.wantCovNote)
			}
			if len(c.Findings) != 0 {
				t.Errorf("findings = %+v, want none on a not_evaluable control", c.Findings)
			}
			if rep.Verdict != StatusNotEvaluable {
				t.Errorf("verdict = %q, want %q", rep.Verdict, StatusNotEvaluable)
			}
			if rep.Blocking() {
				t.Error("Blocking() = true; only a hard fail blocks an apply")
			}
			if got := rep.Unwaived(nil); len(got) != 0 {
				t.Errorf("Unwaived = %v, want none", got)
			}
		})
	}
}

// TestFinalizeVerdictPrecedence pins the verdict ladder fail > warn >
// not_evaluable > pass, and that an empty report is not_evaluable rather than a
// vacuous pass.
func TestFinalizeVerdictPrecedence(t *testing.T) {
	cases := []struct {
		name     string
		statuses []Status
		want     Status
		wantSum  Summary
	}{
		{name: "empty", want: StatusNotEvaluable},
		{
			name: "pass only", statuses: []Status{StatusPass, StatusPass},
			want: StatusPass, wantSum: Summary{Pass: 2},
		},
		{
			name: "not_evaluable beats pass", statuses: []Status{StatusPass, StatusNotEvaluable},
			want: StatusNotEvaluable, wantSum: Summary{Pass: 1, NotEvaluable: 1},
		},
		{
			name: "warn beats not_evaluable", statuses: []Status{StatusNotEvaluable, StatusWarn},
			want: StatusWarn, wantSum: Summary{Warn: 1, NotEvaluable: 1},
		},
		{
			name: "fail beats warn", statuses: []Status{StatusWarn, StatusFail, StatusPass},
			want: StatusFail, wantSum: Summary{Pass: 1, Fail: 1, Warn: 1},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &Report{}
			for i, st := range tc.statuses {
				r.Controls = append(r.Controls, ControlResult{ID: "C" + string(rune('A'+i)), Status: st})
			}
			r.finalize()
			if r.Verdict != tc.want {
				t.Errorf("verdict = %q, want %q", r.Verdict, tc.want)
			}
			if r.Summary != tc.wantSum {
				t.Errorf("summary = %+v, want %+v", r.Summary, tc.wantSum)
			}
		})
	}
}

// TestReleaseLookupMisses pins the matrix accessors' miss paths — the inputs
// that drive a control to not_evaluable.
func TestReleaseLookupMisses(t *testing.T) {
	m := MustLoad()
	if _, ok := m.Release("no-such-component", "1.0.0"); ok {
		t.Error("Release() found an unknown component")
	}
	if _, ok := m.Release("argocd", "0.0.0-nope"); ok {
		t.Error("Release() found an unrecorded version of a known component")
	}
	if _, ok := m.Cloud("nimbus"); ok {
		t.Error("Cloud() found an unknown cloud")
	}
	if _, ok := m.AddOnRange("not-an-addon"); ok {
		t.Error("AddOnRange() found an unknown add-on")
	}
}

// TestMustLoadIsMemoized asserts MustLoad hands back the one memoized document
// rather than re-parsing (and so cannot panic once Load has succeeded).
func TestMustLoadIsMemoized(t *testing.T) {
	if a, b := MustLoad(), MustLoad(); a != b {
		t.Error("MustLoad returned two different matrices")
	}
}
