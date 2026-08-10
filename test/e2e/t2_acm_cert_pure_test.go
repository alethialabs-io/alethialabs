// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"strings"
	"testing"
)

// The decision matrix. The two rows that matter most are the ERROR rows: a half-wired request and a
// full-bar collision must both fail LOUDLY, because either one skipping quietly would look like the
// certificate was proven on a night it was not.
func TestAcmCertDecide(t *testing.T) {
	base := func() acmCertConfig {
		return acmCertConfig{
			provider: "aws", enabled: true,
			zoneID: "Z123456789ABCDEFGHIJK", zoneName: "e2e.alethialabs.io",
			domainName: "run-1.e2e.alethialabs.io",
		}
	}
	cases := []struct {
		name        string
		mutate      func(*acmCertConfig)
		wantRun     bool
		wantBlocked string // substring
		wantErr     string // substring; "" = no error
	}{
		{"off is silent", func(c *acmCertConfig) { c.enabled = false }, false, "", ""},
		{"aws runs", func(c *acmCertConfig) {}, true, "", ""},
		{"gcp is blocked with a reason", func(c *acmCertConfig) { c.provider = "gcp" }, false, "cert-manager", ""},
		{"azure is blocked with a reason", func(c *acmCertConfig) { c.provider = "azure" }, false, "cert-manager", ""},
		{"hetzner is blocked", func(c *acmCertConfig) { c.provider = "hetzner" }, false, "no managed-certificate", ""},
		{"full bar collides", func(c *acmCertConfig) { c.fullBar = true }, false, "", "cannot both be set"},
		{"missing zone id fails", func(c *acmCertConfig) { c.zoneID = "" }, false, "", envAcmCertZoneID},
		{"missing zone name fails", func(c *acmCertConfig) { c.zoneName = "" }, false, "", envAcmCertZoneName},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.mutate(&c)
			run, blocked, err := c.decide()
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("want an error containing %q, got nil (run=%v blocked=%q)", tc.wantErr, run, blocked)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error must name %q; got: %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if run != tc.wantRun {
				t.Fatalf("run = %v, want %v", run, tc.wantRun)
			}
			if tc.wantBlocked != "" && !strings.Contains(blocked, tc.wantBlocked) {
				t.Fatalf("blocked reason must mention %q; got %q", tc.wantBlocked, blocked)
			}
		})
	}
}

// Every BLOCKED lane must carry a reason a human can act on. A lane that returns false with an empty
// string is how a cloud silently drops out of coverage.
func TestAcmCertLaneReasonsAreSubstantive(t *testing.T) {
	for _, p := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		ok, blocked := acmCertLane(p)
		if ok {
			if blocked != "" {
				t.Errorf("%s: an OK lane must carry no blocked reason, got %q", p, blocked)
			}
			continue
		}
		if len(strings.TrimSpace(blocked)) < 40 {
			t.Errorf("%s: blocked reason is too thin to act on: %q", p, blocked)
		}
	}
}

// The snapshot layer is the whole mechanism, and BOTH halves are load-bearing:
// zone_id makes cloud_dns_enabled false (so validation lands in the delegated zone), and
// acm_certificate is what builds a certificate at all. Either alone proves nothing, so assert both.
func TestAcmCertApplyToSnapshotCarriesBothHalves(t *testing.T) {
	c := acmCertConfig{zoneID: "Z1", domainName: "run-1.e2e.alethialabs.io"}
	snap := map[string]any{"dns": map[string]any{"enabled": true, "zone_id": "", "provider_config": map[string]any{"acm_certificate": false}}}
	c.applyToSnapshot(snap)

	dns, ok := snap["dns"].(map[string]any)
	if !ok {
		t.Fatalf("dns block is not a map: %T", snap["dns"])
	}
	if got := dns["zone_id"]; got != "Z1" {
		t.Errorf("zone_id = %v, want Z1 — without a brought zone, cloud_dns_enabled stays true and ACM validates into a zone we just created, which proves nothing", got)
	}
	if got := dns["domain_name"]; got != "run-1.e2e.alethialabs.io" {
		t.Errorf("domain_name = %v, want the run-scoped name", got)
	}
	pc, ok := dns["provider_config"].(map[string]any)
	if !ok {
		t.Fatalf("provider_config is not a map: %T", dns["provider_config"])
	}
	if pc["acm_certificate"] != true {
		t.Errorf("acm_certificate = %v, want true — this is what builds the certificate", pc["acm_certificate"])
	}
}

// The domain must be run-scoped, because the delegated zone is SHARED and long-lived: two concurrent
// legs writing the same validation record for different tokens is the one cross-run hazard here.
func TestAcmCertDomainIsRunScoped(t *testing.T) {
	a := acmCertDomain("run-1", "e2e.alethialabs.io")
	b := acmCertDomain("run-2", "e2e.alethialabs.io")
	if a == b {
		t.Fatalf("two runs derived the same domain %q — concurrent legs would collide in the shared zone", a)
	}
	for _, d := range []string{a, b} {
		if !strings.HasSuffix(d, ".e2e.alethialabs.io") {
			t.Errorf("%q must sit under the delegated zone, or nothing resolves it", d)
		}
	}
	if got := acmCertDomain("run-1", "e2e.alethialabs.io."); got != "run-1.e2e.alethialabs.io" {
		t.Errorf("a trailing dot must be tolerated; got %q", got)
	}
	if got := acmCertDomain("run-1", ""); got != "" {
		t.Errorf("no zone name must yield no domain, got %q", got)
	}
}

func TestIsACMCertARN(t *testing.T) {
	good := "arn:aws:acm:us-east-1:270587882865:certificate/12345678-1234-1234-1234-123456789012"
	if !isACMCertARN(good) {
		t.Errorf("rejected a valid ACM ARN: %s", good)
	}
	bad := []string{
		"",
		"not-an-arn",
		// An IAM server certificate is a DIFFERENT object an ALB can also carry — a loose pattern
		// would accept it and report a certificate that ACM never issued.
		"arn:aws:iam::270587882865:server-certificate/my-cert",
		"arn:aws:acm:us-east-1:270587882865:certificate/not-a-uuid",
	}
	for _, s := range bad {
		if isACMCertARN(s) {
			t.Errorf("accepted a non-ACM-certificate ARN: %q", s)
		}
	}
}

func TestParseACMCertARN(t *testing.T) {
	arn := "arn:aws:acm:us-east-1:270587882865:certificate/12345678-1234-1234-1234-123456789012"
	got, err := parseACMCertARN([]byte(`{"acm_certificate_arn":"` + arn + `"}`))
	if err != nil || got != arn {
		t.Fatalf("got (%q, %v), want (%q, nil)", got, err, arn)
	}
	// Absent is not an error at this layer — the caller decides.
	if got, err := parseACMCertARN([]byte(`{}`)); err != nil || got != "" {
		t.Fatalf("absent should be ('', nil); got (%q, %v)", got, err)
	}
	// A PRESENT value that is not an ACM ARN is an error: something else claimed the field.
	if _, err := parseACMCertARN([]byte(`{"acm_certificate_arn":"arn:aws:iam::1:server-certificate/x"}`)); err == nil {
		t.Error("a non-ACM ARN in the metadata must be an error, not silently ignored")
	}
}

// The verdict must require the non-vacuity control, not just "a certificate exists".
func TestAcmCertVerdictRequiresTheBroughtZone(t *testing.T) {
	full := acmCertSummary{
		ZoneNotCreated: true, CertIssued: true,
		CertARN: "arn:aws:acm:us-east-1:270587882865:certificate/12345678-1234-1234-1234-123456789012",
	}
	if !acmCertVerdictPass(full) {
		t.Fatal("a complete run must PASS")
	}
	noZoneControl := full
	noZoneControl.ZoneNotCreated = false
	if acmCertVerdictPass(noZoneControl) {
		t.Error("a run that CREATED a zone must not pass — the whole point is that the certificate " +
			"validated against the pre-delegated zone, and without this control the two are indistinguishable")
	}
	noCert := full
	noCert.CertIssued = false
	if acmCertVerdictPass(noCert) {
		t.Error("no issued certificate must not pass")
	}
	badARN := full
	badARN.CertARN = "arn:aws:iam::1:server-certificate/x"
	if acmCertVerdictPass(badARN) {
		t.Error("a non-ACM ARN must not pass")
	}
}

func TestAcmCertSummaryJSONStampsFeatureAndVerdict(t *testing.T) {
	b, err := acmCertSummaryJSON(acmCertSummary{Provider: "aws"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if got["feature"] != "acm-certificate" {
		t.Errorf("feature = %v, want acm-certificate", got["feature"])
	}
	if got["verdict"] != "FAIL" {
		t.Errorf("an empty summary must render FAIL, not blank — a missing verdict reads as green in the rollup; got %v", got["verdict"])
	}
}
