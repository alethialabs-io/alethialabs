// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"slices"

	tfjson "github.com/hashicorp/terraform-json"
)

// RemediationResult is the deterministic verdict on a candidate (post-fix) plan
// relative to the original failing report. It is the safety spine of any
// AI-assisted remediation loop: an LLM may PROPOSE a fix, but the fix is only ever
// accepted when re-running the same deterministic gate confirms it (a) resolves the
// failures and (b) introduces no new ones. The model is never trusted to self-judge.
type RemediationResult struct {
	// CandidateVerdict is the candidate plan's own overall verdict.
	CandidateVerdict Status `json:"candidate_verdict"`
	// Resolved lists control IDs that were failing originally and no longer fail.
	Resolved []string `json:"resolved,omitempty"`
	// StillFailing lists originally-failing controls the candidate did not fix.
	StillFailing []string `json:"still_failing,omitempty"`
	// NewlyFailing lists controls the candidate caused to fail that were not
	// failing before — a remediation that breaks something else.
	NewlyFailing []string `json:"newly_failing,omitempty"`
	// Accepted is true only when every original failure is resolved AND nothing new
	// fails. This is the single gate an LLM-proposed fix must pass.
	Accepted bool `json:"accepted"`
	// Candidate is the full report for the candidate plan (for surfacing/evidence).
	Candidate *Report `json:"candidate"`
}

// ReVerify evaluates a candidate plan and compares its control outcomes to the
// original report. Deterministic and side-effect free.
func ReVerify(ctx context.Context, original *Report, candidate *tfjson.Plan) (*RemediationResult, error) {
	cand, err := Evaluate(ctx, candidate)
	if err != nil {
		return nil, err
	}
	res := &RemediationResult{CandidateVerdict: cand.Verdict, Candidate: cand}

	origFailing := failingSet(original)
	candFailing := failingSet(cand)

	for id := range origFailing {
		if candFailing[id] {
			res.StillFailing = append(res.StillFailing, id)
		} else {
			res.Resolved = append(res.Resolved, id)
		}
	}
	for id := range candFailing {
		if !origFailing[id] {
			res.NewlyFailing = append(res.NewlyFailing, id)
		}
	}

	slices.Sort(res.Resolved)
	slices.Sort(res.StillFailing)
	slices.Sort(res.NewlyFailing)

	res.Accepted = len(res.StillFailing) == 0 && len(res.NewlyFailing) == 0
	return res, nil
}

// Remediator encapsulates one remediation attempt: given the current (failing)
// report, propose a fix and return the resulting candidate plan (already
// re-planned). It is an interface so the LLM + re-plan machinery lives in a higher
// layer (console/runner) while the deterministic, bounded control flow lives here.
// The model never decides acceptance — RunRemediationLoop does, via ReVerify.
type Remediator interface {
	// Attempt returns a candidate plan for attempt N (1-based). A nil plan or an
	// error ends the loop without acceptance.
	Attempt(ctx context.Context, current *Report, attempt int) (*tfjson.Plan, error)
}

// RemediationOutcome is the result of a bounded remediation loop.
type RemediationOutcome struct {
	Succeeded bool               `json:"succeeded"`
	Attempts  int                `json:"attempts"`
	Final     *RemediationResult `json:"final,omitempty"`
}

// RunRemediationLoop drives at most maxAttempts remediation rounds. Each round it
// asks the Remediator for a candidate plan and re-runs the deterministic gate
// against the ORIGINAL report; it stops as soon as a candidate is Accepted (all
// original failures resolved, no regression) or attempts are exhausted. This is
// the safe harness for "AI proposes, the gate disposes": a proposed fix can never
// be applied unless the gate confirms it, and the loop cannot loop forever.
func RunRemediationLoop(ctx context.Context, original *Report, rem Remediator, maxAttempts int) (*RemediationOutcome, error) {
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	outcome := &RemediationOutcome{}
	current := original
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		plan, err := rem.Attempt(ctx, current, attempt)
		if err != nil {
			return outcome, err
		}
		if plan == nil {
			return outcome, nil
		}
		res, err := ReVerify(ctx, original, plan)
		if err != nil {
			return outcome, err
		}
		outcome.Attempts = attempt
		outcome.Final = res
		if res.Accepted {
			outcome.Succeeded = true
			return outcome, nil
		}
		// Feed the candidate's report into the next round so the Remediator can
		// target what still fails.
		current = res.Candidate
	}
	return outcome, nil
}

// failingSet is the set of control IDs with a hard Fail status in a report.
func failingSet(r *Report) map[string]bool {
	out := map[string]bool{}
	if r == nil {
		return out
	}
	for _, c := range r.Controls {
		if c.Status == StatusFail {
			out[c.ID] = true
		}
	}
	return out
}
