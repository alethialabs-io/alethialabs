// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

package e2e

import (
	"context"
	"os"
	"strings"
	"testing"
)

type acmCertParams struct {
	cfg     acmCertConfig
	metaRaw []byte
	jobID   string
}

// runT2AcmCert proves that a REAL, publicly-validated ACM certificate was issued for this run, and
// that it reached the product rather than merely existing in AWS (#1773).
//
// The assertions are ordered fail-earliest, most-informative-first, and the FIRST one is the control
// that makes the rest mean anything.
func runT2AcmCert(t *testing.T, ctx context.Context, cp *ControlPlane, p acmCertParams) {
	t.Helper()

	summary := acmCertSummary{
		Provider:   p.cfg.provider,
		ZoneID:     p.cfg.zoneID,
		DomainName: p.cfg.domainName,
		Verdict:    "FAIL", // only set PASS on the last line, so any t.Fatalf still records a FAIL
	}
	defer func() { writeAcmCertSummary(t, p.cfg, summary) }()

	stateBytes := cp.StateSnapshot(p.jobID)
	if len(stateBytes) == 0 {
		summary.Detail = "no tofu state snapshot for the deploy job"
		t.Fatalf("acm-cert: %s", summary.Detail)
	}

	// (1) THE NON-VACUITY CONTROL, and the reason it comes first.
	//
	// The whole claim is "the certificate validated against a zone that was DELEGATED to us", not
	// "a certificate exists". If the template had created its own zone, ACM would still issue —
	// against a zone nothing on the public internet points at — and every later assertion here
	// would pass identically. Zero created zones is what distinguishes the two, so it is asserted
	// before anything else and before any waiting.
	zones, err := countManagedResources(stateBytes, "aws_route53_zone")
	if err != nil {
		summary.Detail = "could not read aws_route53_zone from state: " + err.Error()
		t.Fatalf("acm-cert: %s", summary.Detail)
	}
	if zones != 0 {
		summary.Detail = "the run CREATED a hosted zone, so the certificate proves nothing about delegation"
		t.Fatalf("acm-cert: %d aws_route53_zone in state, want 0 — %s. cloud_dns_enabled should be false "+
			"because a zone id was brought (%s=%s)", zones, summary.Detail, envAcmCertZoneID, p.cfg.zoneID)
	}
	summary.ZoneNotCreated = true

	// (2) Issuance COMPLETED. aws_acm_certificate_validation blocks until ACM reports the
	// certificate ISSUED, so its presence in state is the issuance proof — not the certificate
	// resource, which is created long before validation succeeds.
	validations, err := countManagedResources(stateBytes, "aws_acm_certificate_validation")
	if err != nil {
		summary.Detail = "could not read aws_acm_certificate_validation from state: " + err.Error()
		t.Fatalf("acm-cert: %s", summary.Detail)
	}
	if validations == 0 {
		summary.Detail = "no aws_acm_certificate_validation in state — the certificate was never validated"
		t.Fatalf("acm-cert: %s. The validation CNAME goes into the BROUGHT zone (%s); if that zone is "+
			"not delegated from Cloudflare, ACM can never resolve it. Check `dig NS %s`",
			summary.Detail, p.cfg.zoneID, p.cfg.zoneName)
	}
	summary.CertIssued = true

	// (3) The ARN crossed into the product. A certificate AWS knows about but Alethia never
	// surfaced is not a delivered capability.
	arn, err := parseACMCertARN(p.metaRaw)
	if err != nil {
		summary.Detail = err.Error()
		t.Fatalf("acm-cert: %s", summary.Detail)
	}
	if arn == "" {
		summary.Detail = "acm_certificate_arn absent from execution_metadata — the template output did not reach the product"
		t.Fatalf("acm-cert: %s", summary.Detail)
	}
	summary.CertARN = arn

	// (4) The certificate GATED a downstream behaviour. With an ARN present, deploy.go switches
	// ArgoCD onto an ALB ingress and pins the certificate to it — so this is the difference between
	// "a certificate was issued" and "the product used it". Reported rather than fatal: the ingress
	// depends on the load-balancer controller, and its absence is a different defect from a
	// certificate that failed to issue.
	if strings.Contains(string(p.metaRaw), "argocd-url") {
		summary.IngressGated = true
	} else {
		t.Logf("acm-cert: NOTE — no argocd-url decision in execution_metadata, so the certificate " +
			"issued but no downstream use of it was observed. Not fatal: that is a load-balancer " +
			"controller question, not a certificate one.")
	}

	if !acmCertVerdictPass(summary) {
		t.Fatalf("acm-cert: verdict did not pass with summary %+v", summary)
	}
	summary.Verdict = "PASS"
	t.Logf("acm-cert: PASS — certificate %s issued for *.%s, validated in the pre-delegated zone %s (no zone created)",
		arn, p.cfg.domainName, p.cfg.zoneID)
}

// writeAcmCertSummary is best-effort: a write failure is logged and never masks the real verdict.
func writeAcmCertSummary(t *testing.T, cfg acmCertConfig, s acmCertSummary) {
	t.Helper()
	path := strings.TrimSpace(os.Getenv(envAcmCertSummary))
	if path == "" {
		return
	}
	b, err := acmCertSummaryJSON(s)
	if err != nil {
		t.Logf("acm-cert: could not marshal summary: %v", err)
		return
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Logf("acm-cert: could not write summary to %s: %v", path, err)
	}
}
