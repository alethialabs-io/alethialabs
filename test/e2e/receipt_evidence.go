// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Evidence-grade assertions over the signed verify receipt — the "regulated / proof-first" surface.
// Deliberately UNTAGGED and pure (no cloud, no Postgres, no build tag), so it is unit-tested here
// AND runs inside T1, which the merge queue actually executes — unlike T2, whose real applies are
// main-gated.
//
// # The hole this closes
//
// VerifySignedReceipt proves the receipt is a real ed25519 signature over a 64-char plan digest with
// an embedded report. It never looks INSIDE that report. So a receipt carrying `report: {}` — no
// controls, no summary, an empty verdict — verified cryptographically and passed, and every E2E leg
// reported "signed receipt verified". A perfectly-signed attestation that nothing was checked is the
// most dangerous artifact this system can produce: it is exactly what a compliance reader would take
// as proof, and it says nothing at all.
//
// It also only length-checked the digest, while its own doc comment claimed "a 64-char HEX sha256" —
// so a 64-character non-hex string satisfied it.
//
// # What is asserted, and what deliberately is not
//
// Asserted: the digest is real hex; the control set is non-empty; the summary tallies agree with the
// controls actually present; the verdict follows from those tallies — fail > warn > not_evaluable >
// pass, computed by `verify.VerdictFor` so this cannot drift from the engine it audits; every control
// is fully identified; the catalog version is recorded; the timestamp parses.
//
// That precedence line used to read "fail > warn > pass, with not_evaluable never manufacturing a
// pass", and the code under it derived the wanted verdict from fail and warn alone — so a report
// that honestly said not_evaluable was failed for not saying pass (#2156). It is stated as the
// engine's four-way order now, and derived rather than restated, because the previous shape was
// self-contradictory in exactly the direction that costs a green nightly.
//
// NOT asserted here: that the digest equals the sha256 of the plan the runner actually applied.
// Nothing in the harness holds those plan bytes, so the check would have to trust the same runner it
// is auditing — a tie that must come from the runner side, not from a re-assertion here. And NOT
// asserted: the Rekor anchor, which the console attaches after the fact and which is absent whenever
// anchoring is disabled; `assertRekorAnchorIfPresent` checks it only when it exists, because
// requiring it would fail every leg that runs with anchoring off.
package e2e

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// isLowerHex reports whether s is entirely lowercase hexadecimal.
func isLowerHex(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f':
		default:
			return false
		}
	}
	return true
}

// knownStatus reports whether s is one of the four statuses the engine can emit. An unknown status
// must never be treated as benign: a reader tallying "not fail" would silently count it as a pass.
func knownStatus(s verify.Status) bool {
	switch s {
	case verify.StatusPass, verify.StatusFail, verify.StatusWarn, verify.StatusNotEvaluable:
		return true
	}
	return false
}

// knownSeverity reports whether s is one of the three risk weights.
func knownSeverity(s verify.Severity) bool {
	switch s {
	case verify.SeverityHigh, verify.SeverityMedium, verify.SeverityLow:
		return true
	}
	return false
}

// AssertReceiptEvidence checks that a signed receipt is evidence a compliance reader could rely on,
// rather than a well-formed envelope around nothing. Call it AFTER VerifySignedReceipt, which owns
// the cryptography; this owns the content.
func AssertReceiptEvidence(sr verify.SignedReceipt) error {
	r := sr.Receipt

	// The digest binds the receipt to a specific plan. A non-hex 64-char string satisfied the old
	// length-only check while binding it to nothing.
	if len(r.PlanSHA256) != 64 || !isLowerHex(r.PlanSHA256) {
		return fmt.Errorf("receipt plan_sha256 = %q, want 64 lowercase hex characters — a digest that is not a real sha256 binds the receipt to no plan at all", r.PlanSHA256)
	}
	if r.Report == nil {
		return fmt.Errorf("receipt carries no report")
	}
	rep := r.Report

	// THE hole: a signed receipt over zero controls. Cryptographically perfect, evidentially empty.
	if len(rep.Controls) == 0 {
		return fmt.Errorf("the verification report contains ZERO controls — a correctly signed receipt attesting that nothing was evaluated is not evidence, and reads to a compliance audience as though it were")
	}
	if strings.TrimSpace(rep.CatalogVersion) == "" {
		return fmt.Errorf("the report records no catalog_version — a verdict is only meaningful against the control set that produced it")
	}
	if !knownStatus(rep.Verdict) {
		return fmt.Errorf("report verdict = %q, which is not a status the engine can emit", rep.Verdict)
	}

	// Every control must be fully identified. An unnamed or unweighted control cannot be audited,
	// and an unknown status would be silently read as "not a failure".
	var pass, fail, warn, notEval int
	frameworksPresent := false
	for i, c := range rep.Controls {
		if strings.TrimSpace(c.ID) == "" {
			return fmt.Errorf("control #%d has no id — it cannot be traced back to the catalog", i)
		}
		if strings.TrimSpace(c.Title) == "" {
			return fmt.Errorf("control %q has no title", c.ID)
		}
		if !knownSeverity(c.Severity) {
			return fmt.Errorf("control %q has severity %q, which is not a known risk weight", c.ID, c.Severity)
		}
		if !knownStatus(c.Status) {
			return fmt.Errorf("control %q has status %q, which is not a status the engine can emit", c.ID, c.Status)
		}
		if len(c.Frameworks) > 0 {
			frameworksPresent = true
		}
		switch c.Status {
		case verify.StatusPass:
			pass++
		case verify.StatusFail:
			fail++
		case verify.StatusWarn:
			warn++
		case verify.StatusNotEvaluable:
			notEval++
		}
	}

	// The summary is what a dashboard renders. If it disagrees with the controls it claims to
	// summarise, the surface a human reads is not the surface that was evaluated.
	got := rep.Summary
	if got.Pass != pass || got.Fail != fail || got.Warn != warn || got.NotEvaluable != notEval {
		return fmt.Errorf("the report summary {pass:%d fail:%d warn:%d not_evaluable:%d} disagrees with the %d controls actually present {pass:%d fail:%d warn:%d not_evaluable:%d} — the tally a reader sees is not the evaluation that ran",
			got.Pass, got.Fail, got.Warn, got.NotEvaluable, len(rep.Controls), pass, fail, warn, notEval)
	}

	// The verdict must follow from the tallies. not_evaluable must never manufacture a pass — that
	// is the false-PASS the whole engine exists to avoid.
	//
	// Derived by the ENGINE'S OWN function rather than re-stated here. The re-statement is what went
	// wrong (#2156): it carried three of verify.VerdictFor's five branches and never consulted
	// notEval, so on `fail=0 warn=0 not_evaluable=1` it computed `pass` and failed the run for
	// reporting not_evaluable honestly — the exact false-PASS rule this block exists to enforce,
	// inverted. A gate that judges an emitter has to mirror every one of its conditions, and the only
	// way that stays true through later changes is to call the emitter's definition.
	want := verify.VerdictFor(verify.Summary{Pass: pass, Fail: fail, Warn: warn, NotEvaluable: notEval})
	if rep.Verdict != want {
		return fmt.Errorf("report verdict = %q but the controls tally to %q (fail=%d warn=%d not_evaluable=%d) — the headline disagrees with the evidence under it", rep.Verdict, want, fail, warn, notEval)
	}
	if r.Verdict != rep.Verdict {
		return fmt.Errorf("the receipt's sealed verdict %q disagrees with its own report's verdict %q", r.Verdict, rep.Verdict)
	}

	// At least one control must carry a framework mapping, or the receipt cannot support any
	// compliance claim — which is the entire reason a regulated buyer asks for it.
	if !frameworksPresent {
		return fmt.Errorf("no control carries a framework mapping (CIS / SOC 2 …) — the receipt cannot support the compliance claim it exists to make")
	}

	// A timestamp that does not parse is not a timestamp. Self-asserted by the runner (there is no
	// RFC 3161 timestamping yet), which is why this checks the format and not its truthfulness.
	if ts := strings.TrimSpace(r.EvaluatedAt); ts != "" {
		if _, err := time.Parse(time.RFC3339, ts); err != nil {
			return fmt.Errorf("receipt evaluated_at = %q, which is not RFC3339: %w", ts, err)
		}
	}
	return nil
}

// assertRekorAnchorIfPresent checks the transparency-log anchor's SHAPE when the console attached
// one. Conditional on purpose: anchoring is additive evidence that is off by default and best-effort
// when on (an unreachable log must never fail an apply), so REQUIRING it here would fail every leg
// running with it disabled — a test that demands a feature the deployment did not enable reports a
// product failure that is not one.
func assertRekorAnchorIfPresent(sr verify.SignedReceipt) error {
	a := sr.Rekor
	if a == nil {
		return nil
	}
	if strings.TrimSpace(a.LogURL) == "" {
		return fmt.Errorf("rekor anchor carries no log_url — it names no log to check against")
	}
	if a.LogIndex < 0 {
		return fmt.Errorf("rekor anchor log_index = %d, want a non-negative log position", a.LogIndex)
	}
	if strings.TrimSpace(a.Body) == "" {
		return fmt.Errorf("rekor anchor carries no body — there is nothing to recompute the entry from")
	}
	// The SET is what makes the entry's existence verifiable offline; an anchor without it is a
	// claim about a log rather than proof from one.
	if strings.TrimSpace(a.SignedEntryTimestamp) == "" {
		return fmt.Errorf("rekor anchor carries no signed_entry_timestamp — its existence is not offline-verifiable")
	}
	if _, err := base64.StdEncoding.DecodeString(a.SignedEntryTimestamp); err != nil {
		return fmt.Errorf("rekor anchor signed_entry_timestamp is not valid base64: %w", err)
	}
	return nil
}

// EvidenceVerdict renders a one-line, human-readable summary of what the receipt actually attests.
// Used in the scenario log and the proof bundle, where "signed receipt verified" alone has proven
// too easy to read as "and it checked something".
func EvidenceVerdict(sr verify.SignedReceipt) string {
	rep := sr.Receipt.Report
	if rep == nil {
		return "evidence: NO REPORT"
	}
	anchor := "not anchored"
	if sr.Rekor != nil {
		anchor = fmt.Sprintf("rekor idx=%d", sr.Rekor.LogIndex)
	}
	return fmt.Sprintf("evidence: verdict=%s over %d control(s) {pass=%d fail=%d warn=%d not_evaluable=%d} catalog=%s plan=%s · %s",
		rep.Verdict, len(rep.Controls), rep.Summary.Pass, rep.Summary.Fail, rep.Summary.Warn,
		rep.Summary.NotEvaluable, rep.CatalogVersion, shortDigest(sr.Receipt.PlanSHA256), anchor)
}

// shortDigest abbreviates a digest for a one-line verdict rather than dumping 64 hex characters.
func shortDigest(sha string) string {
	if sha == "" {
		return "absent"
	}
	if len(sha) <= 12 {
		return sha
	}
	return sha[:12] + "…"
}
