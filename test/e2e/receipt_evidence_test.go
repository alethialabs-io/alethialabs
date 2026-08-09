// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Refuters for the evidence-grade receipt assertions. Pure — no cloud, no Postgres, no build tag —
// so they run on every PR, unlike the T2 legs they protect.
//
// The load-bearing case is "a signed receipt over ZERO controls". Before AssertReceiptEvidence, that
// receipt passed: the signature was real, the digest was 64 characters, a report object existed. It
// attested that nothing had been checked, and every leg logged "verified signed receipt".
package e2e

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// passingReceipt is a minimal receipt that is genuine evidence. Every refuter below breaks exactly
// one property of it, so each check is proven load-bearing rather than decorative.
func passingReceipt() verify.SignedReceipt {
	rep := &verify.Report{
		Verdict:        verify.StatusWarn,
		CatalogVersion: verify.CatalogVersion,
		Provider:       "aws",
		Controls: []verify.ControlResult{
			{
				ID: "IAM-001", Title: "No wildcard admin policy", Severity: verify.SeverityHigh,
				Status: verify.StatusPass, Provider: "aws", Frameworks: []string{"CIS-1.16"},
			},
			{
				ID: "S3-002", Title: "Bucket not public", Severity: verify.SeverityMedium,
				Status: verify.StatusWarn, Provider: "aws",
				Findings: []verify.Finding{{Address: "aws_s3_bucket.a", Message: "acl computed"}},
			},
			{
				ID: "KMS-003", Title: "Key rotation enabled", Severity: verify.SeverityLow,
				Status: verify.StatusNotEvaluable, Provider: "aws", Coverage: "key body computed until apply",
			},
		},
		Summary: verify.Summary{Pass: 1, Fail: 0, Warn: 1, NotEvaluable: 1},
	}
	return verify.SignedReceipt{
		Receipt: verify.Receipt{
			Version:        "1",
			PlanSHA256:     strings.Repeat("a1b2", 16), // 64 lowercase hex
			CatalogVersion: verify.CatalogVersion,
			Provider:       "aws",
			Verdict:        verify.StatusWarn,
			Report:         rep,
			EvaluatedAt:    "2026-08-02T12:00:00Z",
		},
		Algorithm: "ed25519",
	}
}

func TestAssertReceiptEvidenceAcceptsRealEvidence(t *testing.T) {
	if err := AssertReceiptEvidence(passingReceipt()); err != nil {
		t.Fatalf("a genuine receipt must pass, or every refuter below is meaningless: %v", err)
	}
}

func TestAssertReceiptEvidenceRefuters(t *testing.T) {
	refuters := map[string]struct {
		mutate  func(*verify.SignedReceipt)
		mention string
	}{
		// THE hole this file exists to close.
		"a signed receipt over ZERO controls": {
			mutate: func(s *verify.SignedReceipt) {
				s.Receipt.Report.Controls = nil
				s.Receipt.Report.Summary = verify.Summary{}
				s.Receipt.Report.Verdict = verify.StatusPass
				s.Receipt.Verdict = verify.StatusPass
			},
			mention: "ZERO controls",
		},
		"an entirely empty report": {
			mutate: func(s *verify.SignedReceipt) { s.Receipt.Report = &verify.Report{} },
		},
		"no report at all": {
			mutate: func(s *verify.SignedReceipt) { s.Receipt.Report = nil },
		},
		// A 64-char digest that is not hex binds the receipt to nothing.
		"a 64-char NON-HEX plan digest": {
			mutate:  func(s *verify.SignedReceipt) { s.Receipt.PlanSHA256 = strings.Repeat("z", 64) },
			mention: "hex",
		},
		"a short plan digest": {
			mutate: func(s *verify.SignedReceipt) { s.Receipt.PlanSHA256 = "abc123" },
		},
		"an uppercase plan digest": {
			mutate: func(s *verify.SignedReceipt) { s.Receipt.PlanSHA256 = strings.Repeat("A1B2", 16) },
		},
		// The dashboard tally must match the controls it claims to summarise.
		"a summary that overcounts passes": {
			mutate:  func(s *verify.SignedReceipt) { s.Receipt.Report.Summary.Pass = 99 },
			mention: "disagrees with",
		},
		"a summary that hides a failure": {
			mutate: func(s *verify.SignedReceipt) {
				s.Receipt.Report.Controls[0].Status = verify.StatusFail
				// Summary and verdict left untouched — the tally now lies.
			},
		},
		// not_evaluable must never manufacture a pass.
		"a PASS verdict over a failing control": {
			mutate: func(s *verify.SignedReceipt) {
				s.Receipt.Report.Controls[0].Status = verify.StatusFail
				s.Receipt.Report.Summary = verify.Summary{Pass: 0, Fail: 1, Warn: 1, NotEvaluable: 1}
				s.Receipt.Report.Verdict = verify.StatusPass
				s.Receipt.Verdict = verify.StatusPass
			},
			mention: "disagrees with the evidence",
		},
		"a PASS verdict over a warn-only report": {
			mutate: func(s *verify.SignedReceipt) {
				s.Receipt.Report.Controls = []verify.ControlResult{{
					ID: "X-1", Title: "t", Severity: verify.SeverityLow,
					Status: verify.StatusWarn, Provider: "aws", Frameworks: []string{"CIS-1.1"},
				}}
				s.Receipt.Report.Summary = verify.Summary{Warn: 1}
				s.Receipt.Report.Verdict = verify.StatusPass // should be warn
				s.Receipt.Verdict = verify.StatusPass
			},
		},
		// THE false-PASS, and the one the old three-branch derivation could not catch: nothing failed,
		// nothing warned, and a control could not be judged — so `pass` is a claim to have checked
		// something the engine says it could not see.
		"a PASS verdict over a not_evaluable-only report": {
			mutate: func(s *verify.SignedReceipt) {
				s.Receipt.Report.Controls = []verify.ControlResult{{
					ID: "X-1", Title: "t", Severity: verify.SeverityLow,
					Status: verify.StatusNotEvaluable, Provider: "aws", Frameworks: []string{"CIS-1.1"},
					Coverage: "policy body computed until apply",
				}}
				s.Receipt.Report.Summary = verify.Summary{NotEvaluable: 1}
				s.Receipt.Report.Verdict = verify.StatusPass // should be not_evaluable
				s.Receipt.Verdict = verify.StatusPass
			},
			mention: "not_evaluable",
		},
		"a PASS verdict where a not_evaluable rides alongside real passes": {
			mutate: func(s *verify.SignedReceipt) {
				s.Receipt.Report.Controls[1].Status = verify.StatusPass // was the only warn
				s.Receipt.Report.Summary = verify.Summary{Pass: 2, NotEvaluable: 1}
				s.Receipt.Report.Verdict = verify.StatusPass // should be not_evaluable
				s.Receipt.Verdict = verify.StatusPass
			},
			mention: "disagrees with the evidence",
		},
		"the sealed verdict disagrees with the report's": {
			mutate: func(s *verify.SignedReceipt) { s.Receipt.Verdict = verify.StatusPass },
		},
		// A control that cannot be traced or weighted cannot be audited.
		"a control with no id":        {mutate: func(s *verify.SignedReceipt) { s.Receipt.Report.Controls[0].ID = "  " }},
		"a control with no title":     {mutate: func(s *verify.SignedReceipt) { s.Receipt.Report.Controls[0].Title = "" }},
		"an unknown severity":         {mutate: func(s *verify.SignedReceipt) { s.Receipt.Report.Controls[0].Severity = "critical" }},
		"an unknown control status":   {mutate: func(s *verify.SignedReceipt) { s.Receipt.Report.Controls[0].Status = "skipped" }},
		"an unknown report verdict":   {mutate: func(s *verify.SignedReceipt) { s.Receipt.Report.Verdict = "green" }},
		"no catalog version":          {mutate: func(s *verify.SignedReceipt) { s.Receipt.Report.CatalogVersion = " " }},
		"an unparseable evaluated_at": {mutate: func(s *verify.SignedReceipt) { s.Receipt.EvaluatedAt = "last tuesday" }},
		// Without a framework mapping the receipt cannot support a compliance claim.
		"no framework mapping anywhere": {
			mutate:  func(s *verify.SignedReceipt) { s.Receipt.Report.Controls[0].Frameworks = nil },
			mention: "framework",
		},
	}

	for name, c := range refuters {
		t.Run(name, func(t *testing.T) {
			sr := passingReceipt()
			c.mutate(&sr)
			err := AssertReceiptEvidence(sr)
			if err == nil {
				t.Fatalf("%q was accepted as evidence — that check is decorative, not load-bearing", name)
			}
			if c.mention != "" && !strings.Contains(err.Error(), c.mention) {
				t.Errorf("error should mention %q so the cause is diagnosable; got %q", c.mention, err.Error())
			}
		})
	}
}

// An honest not_evaluable headline is EVIDENCE, and the gate must accept it (#2156).
//
// These two tallies are not hypothetical — they are what the nightly produced while it was red:
//
//	gcp floor, run 31294893574 — the leg reached "All add-ons Healthy + Synced · Deployment
//	completed successfully" and then died on
//	`report verdict = "not_evaluable" but the controls tally to "pass" (fail=0 warn=0 not_evaluable=1)`.
//
//	aws full-bar, run 31297757420 — `verdict=not_evaluable (pass=2 fail=0 warn=0 not_evaluable=2)`.
//
// The old derivation consulted fail and warn only, so both computed `want = pass` and failed a run
// that had nothing wrong with it. Both must pass now, and neither may be "fixed" by teaching the
// engine to round not_evaluable up — the refuters above hold that door shut.
func TestAssertReceiptEvidenceAcceptsAnHonestNotEvaluable(t *testing.T) {
	cases := map[string]func(*verify.SignedReceipt){
		"fail=0 warn=0 not_evaluable=1 (the gcp floor leg)": func(s *verify.SignedReceipt) {
			s.Receipt.Report.Controls = []verify.ControlResult{{
				ID: "SCOPE-001", Title: "Every planned resource is in a control's scope",
				Severity: verify.SeverityMedium, Status: verify.StatusNotEvaluable, Provider: "gcp",
				Frameworks: []string{"CIS-1.1"},
				Coverage:   "1 resource from an unrecognized provider",
			}}
			s.Receipt.Report.Summary = verify.Summary{NotEvaluable: 1}
			s.Receipt.Report.Verdict = verify.StatusNotEvaluable
			s.Receipt.Verdict = verify.StatusNotEvaluable
		},
		"pass=2 not_evaluable=2 (the aws full-bar proof)": func(s *verify.SignedReceipt) {
			s.Receipt.Report.Controls[1].Status = verify.StatusPass // was the only warn
			s.Receipt.Report.Controls = append(s.Receipt.Report.Controls, verify.ControlResult{
				ID: "SCOPE-001", Title: "Every planned resource is in a control's scope",
				Severity: verify.SeverityMedium, Status: verify.StatusNotEvaluable, Provider: "aws",
				Coverage: "1 resource from an unrecognized provider",
			})
			s.Receipt.Report.Summary = verify.Summary{Pass: 2, NotEvaluable: 2}
			s.Receipt.Report.Verdict = verify.StatusNotEvaluable
			s.Receipt.Verdict = verify.StatusNotEvaluable
		},
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			sr := passingReceipt()
			mutate(&sr)
			if err := AssertReceiptEvidence(sr); err != nil {
				t.Fatalf("the gate refused an honest not_evaluable receipt — it is failing runs that succeeded: %v", err)
			}
		})
	}
}

// The gate must not have its own opinion about the precedence — it must be the engine's. Whatever
// verify.VerdictFor says a tally rolls up to, a receipt carrying that verdict is consistent and a
// receipt carrying any other verdict is not. This is what stops the two drifting apart again.
func TestAssertReceiptEvidenceMirrorsTheEngineVerdict(t *testing.T) {
	statuses := []verify.Status{verify.StatusPass, verify.StatusFail, verify.StatusWarn, verify.StatusNotEvaluable}
	for _, st := range statuses {
		t.Run(string(st), func(t *testing.T) {
			sr := passingReceipt()
			sr.Receipt.Report.Controls = []verify.ControlResult{{
				ID: "X-1", Title: "t", Severity: verify.SeverityLow, Status: st, Provider: "aws",
				Frameworks: []string{"CIS-1.1"},
			}}
			sum := verify.Summary{}
			switch st {
			case verify.StatusPass:
				sum.Pass = 1
			case verify.StatusFail:
				sum.Fail = 1
			case verify.StatusWarn:
				sum.Warn = 1
			case verify.StatusNotEvaluable:
				sum.NotEvaluable = 1
			}
			sr.Receipt.Report.Summary = sum

			want := verify.VerdictFor(sum)
			sr.Receipt.Report.Verdict = want
			sr.Receipt.Verdict = want
			if err := AssertReceiptEvidence(sr); err != nil {
				t.Fatalf("the engine rolls %v up to %q, so the gate must accept it: %v", sum, want, err)
			}

			// Every OTHER verdict over the same tally is a disagreement with the evidence.
			for _, other := range statuses {
				if other == want {
					continue
				}
				sr.Receipt.Report.Verdict = other
				sr.Receipt.Verdict = other
				if err := AssertReceiptEvidence(sr); err == nil {
					t.Errorf("verdict %q over a tally that rolls up to %q was accepted", other, want)
				}
			}
		})
	}
}

// An absent evaluated_at is tolerated (it is optional on the receipt); a malformed one is not.
func TestAssertReceiptEvidenceAllowsAbsentTimestamp(t *testing.T) {
	sr := passingReceipt()
	sr.Receipt.EvaluatedAt = ""
	if err := AssertReceiptEvidence(sr); err != nil {
		t.Fatalf("an absent evaluated_at is optional on the receipt: %v", err)
	}
}

func TestAssertRekorAnchorIfPresent(t *testing.T) {
	// Absent is fine: anchoring is additive evidence, off by default and best-effort when on.
	// Requiring it would fail every leg running with it disabled.
	if err := assertRekorAnchorIfPresent(passingReceipt()); err != nil {
		t.Fatalf("no anchor must be tolerated: %v", err)
	}

	good := verify.RekorAnchor{
		LogURL:               "https://rekor.sigstore.dev",
		LogIndex:             42,
		Body:                 "eyJhcGlWZXJzaW9uIjoiMC4wLjEifQ==",
		SignedEntryTimestamp: "c2lnbmF0dXJl",
	}
	sr := passingReceipt()
	sr.Rekor = &good
	if err := assertRekorAnchorIfPresent(sr); err != nil {
		t.Fatalf("a well-formed anchor must pass: %v", err)
	}

	refuters := map[string]func(*verify.RekorAnchor){
		"no log url":                func(a *verify.RekorAnchor) { a.LogURL = " " },
		"a negative log index":      func(a *verify.RekorAnchor) { a.LogIndex = -1 },
		"no body to recompute from": func(a *verify.RekorAnchor) { a.Body = "" },
		"no signed entry timestamp": func(a *verify.RekorAnchor) { a.SignedEntryTimestamp = "" },
		"a non-base64 SET":          func(a *verify.RekorAnchor) { a.SignedEntryTimestamp = "not base64!!" },
	}
	for name, mutate := range refuters {
		t.Run(name, func(t *testing.T) {
			anchor := good
			mutate(&anchor)
			s := passingReceipt()
			s.Rekor = &anchor
			if err := assertRekorAnchorIfPresent(s); err == nil {
				t.Fatalf("%q was accepted — an anchor that cannot be checked is a claim about a log, not proof from one", name)
			}
		})
	}
}

func TestEvidenceVerdict(t *testing.T) {
	got := EvidenceVerdict(passingReceipt())
	for _, want := range []string{"verdict=warn", "3 control(s)", "pass=1", "not_evaluable=1", "not anchored"} {
		if !strings.Contains(got, want) {
			t.Errorf("verdict %q is missing %q", got, want)
		}
	}
	// The digest is abbreviated, never dumped in full.
	if strings.Contains(got, strings.Repeat("a1b2", 16)) {
		t.Errorf("the verdict should abbreviate the plan digest, got %q", got)
	}

	sr := passingReceipt()
	sr.Rekor = &verify.RekorAnchor{LogIndex: 7}
	if !strings.Contains(EvidenceVerdict(sr), "rekor idx=7") {
		t.Errorf("an anchored receipt should say so: %q", EvidenceVerdict(sr))
	}

	sr2 := passingReceipt()
	sr2.Receipt.Report = nil
	if !strings.Contains(EvidenceVerdict(sr2), "NO REPORT") {
		t.Errorf("a reportless receipt must say so loudly: %q", EvidenceVerdict(sr2))
	}
}
