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
			runEnv:     "run-1",
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
		// #2630 withholds ALETHIA_E2E_ACM_CERT on a max-config dimension, which is right — the
		// variable is set on every run and `full` sets MAX_CONFIG by definition, so the hard failure
		// above made two of aws's five cells permanently unrunnable. But it lands in the `!enabled`
		// branch, which was SILENT, and the fullBar arm refuses loudly precisely "because a silent
		// skip here would look like the cert was proven on a night the full bar ran". Withheld is a
		// third outcome, and it has to say so.
		{"withheld on a max-config dimension is announced, not silent",
			func(c *acmCertConfig) { c.enabled = false; c.fullBar = true }, false, "not attempted on a max-config dimension", ""},
		{"...and it says the certificate was not proven, so an absence cannot read as a pass",
			func(c *acmCertConfig) { c.enabled = false; c.fullBar = true }, false, "was NOT proven by this run", ""},
		{"missing zone id fails", func(c *acmCertConfig) { c.zoneID = "" }, false, "", envAcmCertZoneID},
		{"missing zone name fails", func(c *acmCertConfig) { c.zoneName = "" }, false, "", envAcmCertZoneName},
		// #2566 finding 5. acmCertDomain falls back to the bare zone name when ALETHIA_E2E_ENV is
		// empty, and wiring the scenario made that fallback reachable: the driver derives its own env
		// as `local<hex>` when the variable is unset, so a manual run would provision env `local<hex>`
		// while writing an UN-SCOPED validation record into the shared, long-lived zone — removing
		// the very run-scoping that exists so two concurrent legs never collide on one record.
		{"an empty run env is refused rather than falling back to the zone apex",
			func(c *acmCertConfig) { c.runEnv = ""; c.domainName = c.zoneName }, false, "", "ALETHIA_E2E_ENV"},
		// …and the refusal must name the apex it declined to use, or an operator cannot tell what it
		// was about to do.
		{"...and the refusal names the apex", func(c *acmCertConfig) { c.runEnv = ""; c.domainName = c.zoneName }, false, "", "e2e.alethialabs.io"},
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

// TestParseACMCertARN_ReadsTheRunnersRealShape is the regression for #3042 — the ONE assertion that
// red'd AWS run 33155063965 after a complete provision, a real issued certificate and a clean
// custody chain.
//
// The runner does not promote arbitrary tofu outputs to the top level of execution_metadata: it
// lifts cluster_name / cluster_endpoint / argocd_url by name and puts everything else under
// `outputs` (buildDeployMetadata, apps/runner/internal/agent/runner.go — pinned from that side by
// TestDeployMetadata_TofuOutputsAreNestedNotPromoted). So THIS is the document a passing run
// produces, and before the fix parseACMCertARN returned "" for it and the scenario reported
// "the template output did not reach the product" about a product that had it.
func TestParseACMCertARN_ReadsTheRunnersRealShape(t *testing.T) {
	const arn = "arn:aws:acm:us-east-1:270587882865:certificate/40ebff10-ed21-40eb-a445-a445e7df6968"
	// Trimmed to the shape that matters: the lifted keys at the top, every other output nested.
	real := `{"cluster_name":"eks-use1-prod-acme",
	          "cluster_endpoint":"https://C0ADA.gr7.us-east-1.eks.amazonaws.com",
	          "cluster_ready":true,
	          "outputs":{"eks_cluster_arn":"arn:aws:eks:us-east-1:270587882865:cluster/x",
	                     "acm_certificate_arn":"` + arn + `"}}`
	got, err := parseACMCertARN([]byte(real))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got != arn {
		t.Fatalf("outputs.acm_certificate_arn = %q, want %q — the ARN's only home in execution_metadata "+
			"is the nested `outputs` map; reading only the top level is what red'd run 33155063965", got, arn)
	}
}

// A wrong value nested under `outputs` must be an ERROR, not a silent absence — the same rule the
// top level already had. Absence and "something else claimed the field" are different defects and
// a paid run must not have to distinguish them by hand.
func TestParseACMCertARN_NestedWrongValueIsAnError(t *testing.T) {
	_, err := parseACMCertARN([]byte(`{"outputs":{"acm_certificate_arn":"arn:aws:iam::1:server-certificate/x"}}`))
	if err == nil {
		t.Fatal("a non-ACM ARN under outputs must be an error, not silently ignored")
	}
	if !strings.Contains(err.Error(), "outputs.acm_certificate_arn") {
		t.Errorf("the error must name the PATH it read, so the next run's log localises it; got %q", err)
	}
}

// tofu's `{"value": …}` envelope is unwrapped by TofuCLI.Output today, so the bare scalar is what
// lands — but argocd.ExtractOutput, which the runner uses to read this very key, tolerates both.
// The assertion tolerates both for the same reason: a change of mind there must not turn a real
// certificate into a reported absence.
func TestParseACMCertARN_AcceptsTheTofuValueEnvelope(t *testing.T) {
	const arn = "arn:aws:acm:eu-central-1:270587882865:certificate/12345678-1234-1234-1234-123456789012"
	got, err := parseACMCertARN([]byte(`{"outputs":{"acm_certificate_arn":{"type":"string","value":"` + arn + `"}}}`))
	if err != nil || got != arn {
		t.Fatalf("got (%q, %v), want (%q, nil)", got, err, arn)
	}
	// A null-valued envelope (the template's `var.acm_certificate_enable ? … : null` with the
	// feature off) is ABSENCE, not a malformed ARN — it must not become an error.
	if got, err := parseACMCertARN([]byte(`{"outputs":{"acm_certificate_arn":{"value":null}}}`)); err != nil || got != "" {
		t.Fatalf("a null output is absence; got (%q, %v)", got, err)
	}
	// Same for a bare JSON null, which is what a disabled conditional output actually serializes to.
	if got, err := parseACMCertARN([]byte(`{"outputs":{"acm_certificate_arn":null}}`)); err != nil || got != "" {
		t.Fatalf("a null output is absence; got (%q, %v)", got, err)
	}
}

// The absence DIAGNOSTIC has to name what did arrive. #3042's log said only "absent", which left
// "the runner never posted" and "the key is one level down" indistinguishable — the shape that
// costs a second paid run.
func TestAcmCertMetaKeysNamesWhatArrived(t *testing.T) {
	got := acmCertMetaKeys([]byte(`{"cluster_ready":true,"cluster_name":"x","outputs":{"vpc_id":"vpc-1","eks_cluster_arn":"a"}}`))
	for _, want := range []string{"cluster_name", "cluster_ready", "outputs.eks_cluster_arn", "outputs.vpc_id"} {
		if !strings.Contains(got, want) {
			t.Errorf("key listing %q does not name %q", got, want)
		}
	}
	// The two absence shapes must READ differently — a listing that says the same thing for both is
	// the guard-that-reports-green defect one level down.
	noOutputs := acmCertMetaKeys([]byte(`{"cluster_name":"x"}`))
	if !strings.Contains(noOutputs, "NO `outputs`") {
		t.Errorf("metadata with no outputs object must say so; got %q", noOutputs)
	}
	if empty := acmCertMetaKeys(nil); empty == noOutputs {
		t.Errorf("an ABSENT metadata document must not read like one that merely has no outputs; both said %q", empty)
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

// TestAcmCertNotRequestedStaysSilent is deliberately NOT a row in the table above: that harness
// asserts `if tc.wantBlocked != "" && !strings.Contains(...)`, so a row wanting the EMPTY string
// skips its own assertion and passes whatever `decide()` returns. A case that cannot fail is worse
// than no case, because it reads as coverage.
//
// The silence matters. Announcing on every floor night that a scenario nobody asked for did not run
// trains the reader to skip the line — and that line is the one carrying the withheld notice when
// max-config IS on.
func TestAcmCertNotRequestedStaysSilent(t *testing.T) {
	c := acmCertConfig{provider: "aws", enabled: false, fullBar: false}
	run, blocked, err := c.decide()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run {
		t.Error("a scenario nobody requested must not run")
	}
	if blocked != "" {
		t.Errorf("no max-config, no request — there is nothing to announce, got %q", blocked)
	}
}
