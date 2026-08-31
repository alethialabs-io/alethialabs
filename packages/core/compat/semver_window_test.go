// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat

import "testing"

// TestCheckSemverWindow pins the contract CheckSemverWindow shares with checkK8sRange:
// three statuses, and not_evaluable NEVER collapses into either of the other two.
//
// The rows that matter most are the ones asserting not_evaluable. A window whose bound
// is unparseable has told us nothing, and reading that as a pass is how a support
// contract silently admits everything — the same "found nothing" / "nothing wrong"
// collapse this repository keeps paying for.
func TestCheckSemverWindow(t *testing.T) {
	for _, tc := range []struct {
		name          string
		v, min, max   string
		want          Status
		wantDetailSub string
	}{
		{name: "inside an open-ended floor", v: "v3.3.9", min: "v3.3.9", max: "", want: StatusPass},
		{name: "above an open-ended floor", v: "v3.4.1", min: "v3.3.9", max: "", want: StatusPass},
		{name: "below the floor", v: "v3.1.8", min: "v3.3.9", max: "", want: StatusFail},
		{name: "lower bound is inclusive", v: "v3.3.0", min: "v3.3.0", max: "", want: StatusPass},
		{name: "upper bound is inclusive", v: "v3.4.0", min: "v3.3.0", max: "v3.4.0", want: StatusPass},
		{name: "above the ceiling", v: "v3.4.1", min: "v3.3.0", max: "v3.4.0", want: StatusFail},

		// The truncated vMAJOR.MINOR form. x/mod accepts it and orders it as v2.11.0, which is what
		// lets the matrix's recorded "v2.11" participate in a comparison at all instead of tripping
		// the unparseable arm and being silently excused.
		{name: "a two-component version still compares", v: "v2.11", min: "v3.3.9", max: "", want: StatusFail},
		{name: "a missing v prefix is normalised", v: "3.3.9", min: "v3.3.9", max: "", want: StatusPass},
		{name: "a bound missing its v prefix is normalised", v: "v3.3.9", min: "3.3.9", max: "", want: StatusPass},

		// A pre-release sorts BELOW its release. Asserted deliberately: it is the behaviour a floor
		// wants, and it is what a naive field-by-field comparison gets wrong.
		{name: "a pre-release sorts below its release", v: "v3.3.9-rc1", min: "v3.3.9", max: "", want: StatusFail},

		{name: "no window recorded is never a pass", v: "v3.3.9", min: "", max: "", want: StatusNotEvaluable, wantDetailSub: "no supported version window recorded"},
		{name: "an empty subject is not evaluable", v: "", min: "v3.3.9", max: "", want: StatusNotEvaluable, wantDetailSub: "unset or unparseable"},
		{name: "an unparseable subject is not evaluable", v: "latest", min: "v3.3.9", max: "", want: StatusNotEvaluable, wantDetailSub: "unset or unparseable"},

		// NOT a pass. An unparseable bound is a broken window, and the detail must name WHICH bound
		// so the fix lands on the right one.
		{name: "an unparseable lower bound names itself", v: "v3.3.9", min: "banana", max: "", want: StatusNotEvaluable, wantDetailSub: "lower bound"},
		{name: "an unparseable upper bound names itself", v: "v3.3.9", min: "", max: "banana", want: StatusNotEvaluable, wantDetailSub: "upper bound"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, detail := CheckSemverWindow(tc.v, tc.min, tc.max)
			if got != tc.want {
				t.Fatalf("CheckSemverWindow(%q, %q, %q) = %s (%s), want %s", tc.v, tc.min, tc.max, got, detail, tc.want)
			}
			if tc.wantDetailSub != "" && !contains(detail, tc.wantDetailSub) {
				t.Errorf("detail %q does not mention %q — a not_evaluable that does not say what it could not read is not actionable", detail, tc.wantDetailSub)
			}
		})
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// TestSupportedWindowAccessor asserts the accessor's negative branch: "declared none" and
// "declared one with both bounds empty" are the SAME statement — we have not said — and
// neither may be read as an open window.
func TestSupportedWindowAccessor(t *testing.T) {
	both := SupportedWindow{}
	m := &Matrix{Components: []Component{
		{ID: "declared", Supported: &SupportedWindow{AppVersionMin: "v1.0.0"}},
		{ID: "empty-window", Supported: &both},
		{ID: "undeclared"},
	}}
	for _, tc := range []struct {
		id     string
		wantOK bool
	}{
		{"declared", true},
		{"empty-window", false},
		{"undeclared", false},
		{"absent", false},
	} {
		if _, ok := m.SupportedWindow(tc.id); ok != tc.wantOK {
			t.Errorf("SupportedWindow(%q) ok = %v, want %v", tc.id, ok, tc.wantOK)
		}
	}
}

// TestArgoCDWindowRefusesTheRecordedBrokenReleases drives the SHIPPED matrix rather than a
// fixture, so it fails if the real window is ever widened past a release recorded as broken.
// TestCouplingArgoCD checks the same invariant from the couplings side; this one states it
// as a property of the matrix alone, with no dependency on the Go pin.
func TestArgoCDWindowRefusesTheRecordedBrokenReleases(t *testing.T) {
	m := MustLoad()
	win, ok := m.SupportedWindow("argocd")
	if !ok {
		t.Fatal("the shipped matrix declares no argocd support window")
	}
	comp, ok := m.Component("argocd")
	if !ok {
		t.Fatal("the shipped matrix has no argocd component")
	}
	checked := 0
	for _, r := range comp.Releases {
		if !r.Unsupported {
			continue
		}
		checked++
		if st, _ := CheckSemverWindow(r.AppVersion, win.AppVersionMin, win.AppVersionMax); st != StatusFail {
			t.Errorf("window %s does not REFUSE unsupported chart %s (app %s): got %s", SemverLabel(win.AppVersionMin, win.AppVersionMax), r.Version, r.AppVersion, st)
		}
	}
	if checked == 0 {
		t.Fatal("no unsupported release in the shipped matrix — this test compared nothing")
	}
}
