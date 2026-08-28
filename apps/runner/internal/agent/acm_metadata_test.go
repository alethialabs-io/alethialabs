// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// TestDeployMetadata_TofuOutputsAreNestedNotPromoted pins the EMITTER half of the contract the
// ACM acceptance scenario reads (#3042).
//
// AWS run 33155063965 provisioned a real cluster, issued and validated a real certificate, and
// then failed on "acm_certificate_arn absent from execution_metadata — the template output did not
// reach the product". It was not absent. buildDeployMetadata lifts a SHORT, named list of facts to
// the top level (cluster_name / cluster_endpoint / argocd_url) and puts every other tofu output
// WHOLESALE under `outputs`; the assertion only ever looked at the top level, so a fact that was
// present the whole time read as a propagation defect and cost a full paid AWS run to say so.
//
// This test states the shape out loud on the side that produces it, so a future promotion (or a
// rename of the `outputs` envelope) breaks here — in a free unit run — rather than in a paid one.
func TestDeployMetadata_TofuOutputsAreNestedNotPromoted(t *testing.T) {
	const arn = "arn:aws:acm:us-east-1:270587882865:certificate/40ebff10-ed21-40eb-a445-a445e7df6968"
	result := &provisioner.PlanResult{
		ClusterName:     "eks-use1-prod-acme",
		ClusterEndpoint: "https://C0ADA0FDC4515B77AD9624B2449DD501.gr7.us-east-1.eks.amazonaws.com",
		Outputs: map[string]interface{}{
			"acm_certificate_arn":  arn,
			"eks_cluster_endpoint": "https://C0ADA0FDC4515B77AD9624B2449DD501.gr7.us-east-1.eks.amazonaws.com",
		},
	}
	metadata := buildDeployMetadata(result)

	// The ARN is NOT credential-bearing, so neither scrub may take it. `client_certificate` is on
	// the denylist and `acm_certificate_arn` contains "certificate" — a sloppier denylist entry
	// would silently eat it, which is exactly the failure this scenario would then misreport.
	if dropped := scrubMetadataTree(metadata); len(dropped) > 0 {
		t.Fatalf("the whole-blob denylist dropped %v — an ACM ARN is a public identifier, not a credential", dropped)
	}

	outputs, ok := metadata["outputs"].(map[string]any)
	if !ok {
		t.Fatalf("execution_metadata carries no `outputs` object (%T) — every non-lifted tofu output rides in it", metadata["outputs"])
	}
	if got := outputs["acm_certificate_arn"]; got != arn {
		t.Errorf("outputs.acm_certificate_arn = %v, want %q — this is the ONLY place the ARN reaches the console", got, arn)
	}

	// The negative half, and the reason the e2e reader had to change rather than the runner: the
	// ARN is deliberately not on the lifted list. Asserting its ABSENCE at the top level is what
	// makes "read the nested path" a contract instead of a defensive guess.
	if _, promoted := metadata["acm_certificate_arn"]; promoted {
		t.Error("acm_certificate_arn was promoted to the top level — if that is now intended, say so " +
			"here and in test/e2e/t2_acm_cert.go's acmCertMetaPaths, which reads both")
	}

	// It must survive a JSON round-trip: execution_metadata crosses to the console as jsonb, and
	// the e2e reads it back off the `jobs` row, never off this map.
	b, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("marshal execution_metadata: %v", err)
	}
	var back struct {
		Outputs struct {
			ACMCertificateArn string `json:"acm_certificate_arn"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal execution_metadata: %v", err)
	}
	if back.Outputs.ACMCertificateArn != arn {
		t.Errorf("after a jsonb round-trip outputs.acm_certificate_arn = %q, want %q", back.Outputs.ACMCertificateArn, arn)
	}
}
