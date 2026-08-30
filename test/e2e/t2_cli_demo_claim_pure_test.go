// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The claim assertion's FAILURE MESSAGE, pinned without a cluster.
//
// `AssertCLIDemoJobClaimed` exists so a tenancy mismatch is reported at the claim layer instead of
// surfacing as a deploy TIMEOUT forty minutes later, naming a cluster that is fine. That value is
// entirely in the message: if it stops naming the rule, the operator starts looking at the wrong
// thing again and the assertion has quietly become a slower version of the bug.
//
// So the message is tested, in milliseconds, on every PR — rather than proven once by deliberately
// breaking a real dispatch.

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCLIDemoClaimFailureNamesTheTenancyRule(t *testing.T) {
	// Drive the loop fast; the poll interval is a var precisely so this costs nothing.
	prevPoll, prevWindow := cliDemoClaimPoll, cliDemoClaimWindow
	cliDemoClaimPoll, cliDemoClaimWindow = time.Millisecond, 30*time.Millisecond
	t.Cleanup(func() { cliDemoClaimPoll, cliDemoClaimWindow = prevPoll, prevWindow })

	run := &CLIDemoRun{ApplyJobID: "job-abc", OrgID: "org-xyz"}
	// A job that never leaves QUEUED — exactly what a runner in the wrong org produces.
	err := awaitCLIDemoClaim(context.Background(), run, func(context.Context) (string, error) {
		return "QUEUED", nil
	})
	if err == nil {
		t.Fatal("a job that never left QUEUED was reported as claimed — the assertion proves nothing")
	}
	msg := err.Error()
	// Each of these is a thing the reader needs and would otherwise go looking for in the wrong
	// place. Asserted individually so a rewrite that drops one fails on that one.
	for _, want := range []string{
		"job-abc",        // WHICH job
		"org-xyz",        // the org the runner was registered in
		"claim_next_job", // the mechanism
		"#392",           // where the rule is written down
		"TENANCY",        // the class, stated plainly
		"never CLAIMED",  // what actually happened
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("the claim failure does not mention %q — the operator would be sent at the cluster:\n%s", want, msg)
		}
	}
	// And it must NOT read as a provisioning failure, which is the whole point.
	if strings.Contains(strings.ToLower(msg), "cluster_ready") {
		t.Errorf("the message frames this as a provisioning failure:\n%s", msg)
	}
}

// TestCLIDemoClaimPassesAsSoonAsTheJobMoves — the other direction. A guard that only ever fails is
// as useless as one that only ever passes, and this one gates a paid run.
func TestCLIDemoClaimPassesAsSoonAsTheJobMoves(t *testing.T) {
	prevPoll := cliDemoClaimPoll
	cliDemoClaimPoll = time.Millisecond
	t.Cleanup(func() { cliDemoClaimPoll = prevPoll })

	calls := 0
	err := awaitCLIDemoClaim(context.Background(), &CLIDemoRun{ApplyJobID: "j", OrgID: "o"},
		func(context.Context) (string, error) {
			calls++
			if calls < 3 {
				return "QUEUED", nil
			}
			return "RUNNING", nil
		})
	if err != nil {
		t.Fatalf("a job that was claimed on the third read reported a failure: %v", err)
	}
	if calls < 3 {
		t.Errorf("returned after %d reads — it did not actually poll", calls)
	}
}
