// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-language parity fixture for the compat engine — the GO half, and the authority.
//
// apps/console/lib/compat/engine.ts describes itself as producing "byte-for-byte the same verdict
// + control statuses the Go engine produces for the same subject (the contract-lock discipline)".
// Nothing checked that, and it was false in two places, both of which sit on a fail-closed gate:
//
//  1. parseMinor. TS used `Number()` + `Number.isInteger`; Go uses `strconv.Atoi`. `Number("")` is
//     0 and `Number.isInteger(0)` is true, so `"1."`, `".5"`, `"1. 35"`, `"1.0x10"` and `"1.1e2"`
//     were JUDGED by the console and `not_evaluable` by the Go apply gate. The console therefore
//     showed a pass or a fail where the gate refused to decide — in both directions.
//
//  2. The waiver expiry. `new Date("garbage").getTime()` is NaN and `NaN < now` is false, so an
//     unparseable expiry made a waiver valid FOREVER on the console side. Go never had that bug
//     because Expiry is a time.Time and a malformed value fails json.Unmarshal at the boundary —
//     the Override simply never exists. The type did the work.
//
// GO IS THE SOURCE HERE, and the direction follows authority: compat.Evaluate is what runs inside
// provisioner/deploy.go between plan and apply (deploy.go:787), and Report.Unwaived is what
// decides whether the apply proceeds (deploy.go:882). So this test FREEZES the Go answers and the
// console vitest (apps/console/tests/lib/compat/engine-parity.test.ts) proves its own engine
// reaches them. Same shape as test/e2e/chart_workloads_contract_pure_test.go, and the opposite
// direction from packages/format's conformance table, where the console is the authority.
//
// Regenerate:  UPDATE_FIXTURES=1 go test ./compat/ -run TestEngineParityFixture

package compat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const parityFixture = "engine_parity.json"

// parityControl is the slice of a ControlResult the two engines must agree on. Title, severity and
// coverage prose are deliberately excluded: they are presentation, they churn, and pinning them
// would make this fixture fail for reasons that have nothing to do with the gate.
type parityControl struct {
	ID     string `json:"id"`
	Status Status `json:"status"`
}

// parityEvalCase pins Evaluate's per-control verdict for one subject.
type parityEvalCase struct {
	ID      string          `json:"id"`
	Subject Subject         `json:"subject"`
	Want    []parityControl `json:"want"`
}

// parityWaiverCase pins whether a waiver applies.
//
// Expiry is a RAW STRING rather than a timestamp, and that is the entire point of the case: what
// must agree is each language's answer for a value one of them cannot parse. Go's answer for an
// unparseable expiry is reached by refusing to decode the Override at all, so `decodes: false`
// records that refusal explicitly rather than leaving the reader to infer it.
type parityWaiverCase struct {
	ID string `json:"id"`
	// Controls is the waiver's control list.
	Controls []string `json:"controls"`
	// Expiry as it appears on the wire. "" means no expiry.
	Expiry string `json:"expiry"`
	// Decodes records whether Go accepts this expiry at the JSON boundary. When false, Go has no
	// Override at all, and the TS mirror must reach the same outcome by its own route.
	Decodes bool `json:"decodes"`
	// Now is the instant the waiver is evaluated at, so the case is not a function of wall time.
	Now string `json:"now"`
	// Failing are the control IDs a report is failing, standing in for a real Report.
	Failing []string `json:"failing_controls"`
	// Want is the resulting unwaived set — non-empty means the apply stays blocked.
	Want []string `json:"want"`
}

type parityFile struct {
	Doc      string             `json:"_doc"`
	Version  int                `json:"version"`
	Evaluate []parityEvalCase   `json:"evaluate"`
	Waiver   []parityWaiverCase `json:"waiver"`
}

// parityNow is the fixed instant every waiver case is evaluated at.
const parityNow = "2026-09-01T12:00:00Z"

// evalSubjects are the hand-authored Evaluate inputs. They concentrate on the PARSE BOUNDARY,
// because that is where the two languages diverged and because those verdicts do not move when
// the matrix is updated — a `not_evaluable` from an unparseable version is a property of the
// parser, not of the catalog. A few well-formed subjects ride along so the fixture would notice
// an engine that returned not_evaluable for everything.
func evalSubjects() []struct {
	id      string
	subject Subject
} {
	return []struct {
		id      string
		subject Subject
	}{
		{"evaluate/k8s/well-formed-minor", Subject{Providers: []string{"aws"}, K8sVersion: "1.31"}},
		{"evaluate/k8s/well-formed-patch-is-truncated", Subject{Providers: []string{"aws"}, K8sVersion: "1.31.6"}},
		{"evaluate/k8s/leading-v-is-stripped", Subject{Providers: []string{"aws"}, K8sVersion: "v1.31"}},
		{"evaluate/k8s/surrounding-space-is-trimmed", Subject{Providers: []string{"aws"}, K8sVersion: "  1.31  "}},
		// Go trims, strips the "v", then trims AGAIN. The TS mirror trimmed only once, so this
		// input reached its parser as " 1.31" — which the old lax Number() happened to accept and
		// a strict Atoi grammar would not. Pinned so the second trim cannot be dropped as
		// redundant.
		{"evaluate/k8s/space-after-the-v-is-trimmed-too", Subject{Providers: []string{"aws"}, K8sVersion: "v 1.31"}},

		// The five that diverged. Every one of these was JUDGED by the console.
		{"evaluate/k8s/TRAILING-DOT-IS-NOT-A-VERSION", Subject{Providers: []string{"aws"}, K8sVersion: "1."}},
		{"evaluate/k8s/LEADING-DOT-IS-NOT-A-VERSION", Subject{Providers: []string{"aws"}, K8sVersion: ".5"}},
		{"evaluate/k8s/INNER-SPACE-IS-NOT-A-VERSION", Subject{Providers: []string{"aws"}, K8sVersion: "1. 35"}},
		{"evaluate/k8s/HEX-IS-NOT-A-VERSION", Subject{Providers: []string{"aws"}, K8sVersion: "1.0x10"}},
		{"evaluate/k8s/EXPONENT-IS-NOT-A-VERSION", Subject{Providers: []string{"aws"}, K8sVersion: "1.1e2"}},

		// Adjacent shapes, so a fix cannot over-correct into rejecting valid input.
		{"evaluate/k8s/no-minor-component", Subject{Providers: []string{"aws"}, K8sVersion: "1"}},
		{"evaluate/k8s/empty-version", Subject{Providers: []string{"aws"}, K8sVersion: ""}},
		{"evaluate/k8s/not-a-number-at-all", Subject{Providers: []string{"aws"}, K8sVersion: "stable"}},
		{"evaluate/k8s/plus-sign-is-accepted-by-Atoi", Subject{Providers: []string{"aws"}, K8sVersion: "+1.+31"}},
		{"evaluate/k8s/beyond-int53-is-not-a-version", Subject{Providers: []string{"aws"}, K8sVersion: "1.99999999999999999999"}},
	}
}

// waiverCases are the hand-authored waiver inputs, concentrated on the expiry boundary.
func waiverCases() []parityWaiverCase {
	const ctrl = "COMPAT-K8S-CLOUD-AWS"
	return []parityWaiverCase{
		{ID: "waiver/no-expiry-waives", Controls: []string{ctrl}, Expiry: ""},
		{ID: "waiver/future-expiry-waives", Controls: []string{ctrl}, Expiry: "2099-01-01T00:00:00Z"},
		{ID: "waiver/past-expiry-does-not-waive", Controls: []string{ctrl}, Expiry: "2020-01-01T00:00:00Z"},
		{ID: "waiver/expiry-exactly-now-still-waives", Controls: []string{ctrl}, Expiry: parityNow},
		{ID: "waiver/a-control-not-listed-is-not-waived", Controls: []string{"COMPAT-SOMETHING-ELSE"}, Expiry: ""},

		// The divergence. Each of these made the console waive FOREVER.
		{ID: "waiver/UNPARSEABLE-EXPIRY-DOES-NOT-WAIVE", Controls: []string{ctrl}, Expiry: "garbage"},
		{ID: "waiver/PARTIAL-DATE-DOES-NOT-WAIVE", Controls: []string{ctrl}, Expiry: "2026-13-45"},
		{ID: "waiver/A-NUMBER-IS-NOT-A-TIMESTAMP", Controls: []string{ctrl}, Expiry: "1756728000"},
	}
}

// buildParity runs the REAL engine over the hand-authored inputs.
func buildParity(t *testing.T) parityFile {
	t.Helper()
	now, err := time.Parse(time.RFC3339, parityNow)
	if err != nil {
		t.Fatalf("parityNow is not RFC3339: %v", err)
	}

	out := parityFile{
		Doc: "GENERATED by packages/core/compat/engine_parity_test.go. DO NOT EDIT. Regenerate: " +
			"UPDATE_FIXTURES=1 go test ./compat/ -run TestEngineParityFixture. Go is the authority — " +
			"compat.Evaluate runs inside the apply gate — and apps/console/tests/lib/compat/" +
			"engine-parity.test.ts proves the TS mirror reproduces these answers.",
		Version: 1,
	}

	for _, c := range evalSubjects() {
		rep := Evaluate(c.subject)
		want := make([]parityControl, 0, len(rep.Controls))
		for _, ctl := range rep.Controls {
			want = append(want, parityControl{ID: ctl.ID, Status: ctl.Status})
		}
		out.Evaluate = append(out.Evaluate, parityEvalCase{ID: c.id, Subject: c.subject, Want: want})
	}

	for _, c := range waiverCases() {
		// Decode the expiry the way the wire does. A failure here IS Go's answer: the Override
		// never comes into existence, so nothing is waived.
		var ov *Override
		decodes := true
		if c.Expiry == "" {
			ov = &Override{Controls: c.Controls}
		} else {
			raw := fmt.Sprintf(`{"controls":%s,"expiry":%q}`, mustJSON(t, c.Controls), c.Expiry)
			var decoded Override
			if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
				decodes = false
			} else {
				ov = &decoded
			}
		}

		failing := []string{"COMPAT-K8S-CLOUD-AWS"}
		rep := &Report{Controls: []ControlResult{{ID: failing[0], Status: StatusFail}}}
		got := rep.UnwaivedAt(ov, now)
		if got == nil {
			got = []string{}
		}

		out.Waiver = append(out.Waiver, parityWaiverCase{
			ID: c.ID, Controls: c.Controls, Expiry: c.Expiry, Decodes: decodes,
			Now: parityNow, Failing: failing, Want: got,
		})
	}
	return out
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// TestEngineParityFixture freezes the Go engine's answers, or regenerates them under
// UPDATE_FIXTURES=1.
func TestEngineParityFixture(t *testing.T) {
	built := buildParity(t)

	// Vacuity, in this repo's standing form. A fixture with no cases would golden-compare clean
	// against an empty file forever and the TS half would assert nothing — the guard would pass
	// because it ran nothing, which must not look like passing because nothing was wrong.
	if len(built.Evaluate) == 0 || len(built.Waiver) == 0 {
		t.Fatalf("no parity cases built (%d evaluate, %d waiver) — the fixture would be vacuous",
			len(built.Evaluate), len(built.Waiver))
	}

	// Every case must have produced at least one control, or "want" is trivially satisfiable.
	for _, c := range built.Evaluate {
		if len(c.Want) == 0 {
			t.Fatalf("%s produced no controls — an empty expectation is not an expectation", c.ID)
		}
	}

	wire, err := json.MarshalIndent(built, "", "\t")
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	wire = append(wire, '\n')

	path := filepath.Join("testdata", parityFixture)
	if os.Getenv("UPDATE_FIXTURES") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(path, wire, 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		t.Logf("wrote %s (%d evaluate, %d waiver cases)", path, len(built.Evaluate), len(built.Waiver))
		return
	}

	committed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v\nRegenerate: UPDATE_FIXTURES=1 go test ./compat/ -run TestEngineParityFixture", path, err)
	}
	if string(committed) != string(wire) {
		t.Errorf("%s is stale — the Go engine and the committed fixture disagree.\n"+
			"Regenerate: UPDATE_FIXTURES=1 go test ./compat/ -run TestEngineParityFixture\n"+
			"NOTE this moves an answer the console is held to; read the diff.", path)
	}
}

// TestWallClockWrappersDelegate closes the gap between what the fixture pins and what production
// runs.
//
// The fixture is generated through CoversAt/UnwaivedAt so it can be deterministic, but
// provisioner/deploy.go calls Covers/Unwaived — the wall-clock forms. If those wrappers did
// anything other than delegate, the whole parity fixture would be pinning a code path the apply
// gate never takes, and would prove nothing about it. So the delegation is asserted directly,
// using only inputs whose answer cannot depend on what time it is.
func TestWallClockWrappersDelegate(t *testing.T) {
	const id = "COMPAT-K8S-CLOUD-AWS"

	// No expiry: covered at every instant, so the wrapper and the explicit form must agree
	// without the test needing to know the clock.
	never := &Override{Controls: []string{id}}
	if !never.Covers(id) {
		t.Error("Covers: an override with no expiry must waive its own control")
	}
	if never.Covers("COMPAT-SOMETHING-ELSE") {
		t.Error("Covers: an override must not waive a control it does not list")
	}
	if got := never.CoversAt(id, time.Now()); got != never.Covers(id) {
		t.Errorf("Covers and CoversAt disagree for a no-expiry override: %v vs %v", never.Covers(id), got)
	}

	// A long-past expiry is expired at every instant a test can run at.
	expired := &Override{Controls: []string{id}, Expiry: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)}
	if expired.Covers(id) {
		t.Error("Covers: a waiver that expired in 2000 must not still waive")
	}

	// A far-future expiry is live at every instant a test can run at.
	live := &Override{Controls: []string{id}, Expiry: time.Date(2999, 1, 1, 0, 0, 0, 0, time.UTC)}
	if !live.Covers(id) {
		t.Error("Covers: a waiver expiring in 2999 must still waive")
	}

	// Nil receiver: the documented nil-safety must survive the indirection.
	var absent *Override
	if absent.Covers(id) {
		t.Error("Covers: a nil override must waive nothing")
	}

	rep := &Report{Controls: []ControlResult{{ID: id, Status: StatusFail}}}
	if got := rep.Unwaived(never); len(got) != 0 {
		t.Errorf("Unwaived: a live waiver should clear the control, got %v", got)
	}
	if got := rep.Unwaived(expired); len(got) != 1 || got[0] != id {
		t.Errorf("Unwaived: an expired waiver must leave the apply blocked, got %v", got)
	}
	if got := rep.Unwaived(absent); len(got) != 1 {
		t.Errorf("Unwaived: no override means nothing is waived, got %v", got)
	}
}

// TestEngineParityFixtureIsNotVacuous pins that the fixture actually exercises the divergence it
// was written for. Without this, someone could delete the malformed-input cases, regenerate, and
// leave a green fixture that proves only the happy path — which is the state that let both bugs
// live in the first place.
func TestEngineParityFixtureIsNotVacuous(t *testing.T) {
	built := buildParity(t)

	notEvaluable := 0
	for _, c := range built.Evaluate {
		for _, w := range c.Want {
			if w.Status == StatusNotEvaluable {
				notEvaluable++
			}
		}
	}
	if notEvaluable < 5 {
		t.Errorf("only %d not_evaluable verdicts in the fixture; the five malformed-version cases "+
			"are the reason it exists", notEvaluable)
	}

	undecodable := 0
	waivedDespiteBadExpiry := 0
	for _, c := range built.Waiver {
		if !c.Decodes {
			undecodable++
			if len(c.Want) == 0 {
				waivedDespiteBadExpiry++
			}
		}
	}
	if undecodable < 3 {
		t.Errorf("only %d undecodable-expiry cases; the fail-open this fixture exists to close "+
			"needs them", undecodable)
	}
	if waivedDespiteBadExpiry > 0 {
		t.Errorf("%d case(s) waived a control on an expiry Go cannot even decode — that is the "+
			"fail-open itself, and it must never be the recorded answer", waivedDespiteBadExpiry)
	}
}
