// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The PURE half of the CLI-demo provisioning bar: it holds the beat table to the step table
// WITHOUT a cloud, so the accounting cannot rot between paid runs.
//
// Deliberately untagged, like t2_cli_demo_pure_test.go, so ci.yml runs it on every PR. The
// expensive half proves the beats WORK; this one proves they are the right beats and that none has
// gone missing — and that is the half that would otherwise only be discovered on stage.

import (
	"strings"
	"testing"
)

// TestCLIDemoBeatsAccountForEveryDrivenStep is the whole contract: every CLIDriven step is either
// performed by a beat or has a written reason it is not. Never both, never neither.
func TestCLIDemoBeatsAccountForEveryDrivenStep(t *testing.T) {
	if err := ValidateCLIDemoBeats(); err != nil {
		t.Fatal(err)
	}
}

// TestCLIDemoBeatsAreNotVacuous — the check above passes trivially if both tables are empty, which
// is exactly how a guard reports green on nothing. Assert the work exists.
//
// The floor is deliberately loose (a count, not a list): pinning the exact set here would mean
// editing this test every time a beat is added, which is the hand-maintained-allowlist shape that
// let `vault-bootstrap` go unregistered for two releases. What must not happen is the table
// EMPTYING, and a floor catches that.
func TestCLIDemoBeatsAreNotVacuous(t *testing.T) {
	if len(CLIDemoBeats) < 10 {
		t.Errorf("only %d beat(s) — the demo is an empty account to a torn-down cluster; that is not it", len(CLIDemoBeats))
	}
	if len(cliDemoNotDriven) == 0 {
		t.Error("nothing is recorded as not-driven, yet `login` cannot be performed by a binary — the exception has gone missing")
	}
	for _, b := range CLIDemoBeats {
		if b.Args == nil {
			t.Errorf("beat %q has no Args", b.StepID)
			continue
		}
		// Build the argv against a zero run. It may reference empty ids — what must not happen is a
		// beat that produces NO command at all, which would exit 0 having run nothing.
		if got := b.Args(&CLIDemoRun{}); len(got) == 0 {
			t.Errorf("beat %q builds an empty argv — it would perform nothing and pass", b.StepID)
		}
	}
}

// TestCLIDemoNotDrivenReasonsAreReasons — an entry that says "n/a" is indistinguishable from an
// oversight, and the entire value of the not-driven list is that a reader can DISAGREE with it.
func TestCLIDemoNotDrivenReasonsAreReasons(t *testing.T) {
	for id, why := range cliDemoNotDriven {
		if len(strings.Fields(why)) < 8 {
			t.Errorf("step %q is excluded with %q — too short to be a reason anyone could argue with", id, why)
		}
	}
}

// TestCLIDemoBeatsEndTornDown — a demo that provisions and does not destroy is a standing bill, and
// the orphan reaper would find it before anyone read the report. The LAST beat must be the destroy.
//
// Asserted on the order rather than on mere presence: a destroy that is not last has beats running
// after the cluster is gone, which is a different (and confusing) failure.
func TestCLIDemoBeatsEndTornDown(t *testing.T) {
	if len(CLIDemoBeats) == 0 {
		t.Fatal("no beats")
	}
	if last := CLIDemoBeats[len(CLIDemoBeats)-1].StepID; last != "destroy" {
		t.Errorf("the last beat is %q, not \"destroy\" — a demo that does not tear down leaves a standing bill", last)
	}
}

// TestCLIDemoBeatsApplyBeforeTheStepsThatReadIt pins the ORDER the demo depends on: everything that
// addresses the apply's job id or the running cluster must come after the apply, and the apply
// after the project exists.
//
// This is not pedantry about sequence. `jobs logs <id>` with an id no beat has minted yet would run
// against the empty string, and the CLI would report "job not found" — a red that reads like a
// product defect and is actually a table-ordering mistake.
func TestCLIDemoBeatsApplyBeforeTheStepsThatReadIt(t *testing.T) {
	pos := map[string]int{}
	for i, b := range CLIDemoBeats {
		pos[b.StepID] = i
	}
	mustPrecede := [][2]string{
		{"project-create", "component-add"},
		{"project-create", "plan"},
		{"plan", "apply"},
		{"apply", "jobs-logs"},
		{"apply", "cluster-get"},
		{"apply", "receipt-verify"},
		{"apply", "destroy"},
	}
	for _, pair := range mustPrecede {
		before, after := pair[0], pair[1]
		bi, bok := pos[before]
		ai, aok := pos[after]
		if !bok || !aok {
			// Not an error here: whether a step is driven at all is TestCLIDemoBeatsAccountFor…'s
			// question, and reporting it twice would send two issues at one cause.
			continue
		}
		if bi >= ai {
			t.Errorf("beat %q (position %d) must come before %q (position %d) — the later beat reads what the earlier one mints",
				before, bi, after, ai)
		}
	}
}
