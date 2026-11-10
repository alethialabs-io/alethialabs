// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The console mints a DEPLOY_RUNNER / UPDATE_RUNNER job's target token at claim time and returns it
// inside the claim response's config_snapshot — the stored job never carries it. This pins the
// runner's half of that contract: a claim body shaped exactly as the console's route serialises it
// (apps/console/app/api/jobs/claim/route.ts) decodes into a deploy config carrying the token.
func TestClaimJob_LifecycleTokenFromClaimResponse(t *testing.T) {
	const body = `{
		"job": {
			"id": "job-lc-1",
			"job_type": "DEPLOY_RUNNER",
			"status": "CLAIMED",
			"config_snapshot": {
				"runner_id": "4f0c1d52-7a1e-4c55-9d0b-2b7f6a1e9c30",
				"runner_name": "edge",
				"region": "us-east-1",
				"cloud_provider": "aws",
				"image_tag": "1.2.3",
				"alethia_url": "https://console.invalid",
				"runner_token": "claim-time-token"
			}
		},
		"cloud_identity": null,
		"connector_credentials": []
	}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	resp, err := NewRunnerAPIClient(server.URL, "exec-1", "exec-token").ClaimJob()
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if resp.Job == nil {
		t.Fatal("expected a job")
	}
	cfg, err := parseRunnerDeployConfig(resp.Job.ConfigSnapshot)
	if err != nil {
		t.Fatalf("parse deploy config: %v", err)
	}
	if cfg.RunnerToken != "claim-time-token" || cfg.RunnerID != "4f0c1d52-7a1e-4c55-9d0b-2b7f6a1e9c30" {
		t.Errorf("got id=%q token=%q, want the claim response's values", cfg.RunnerID, cfg.RunnerToken)
	}
}

// A stored snapshot carries no runner_token; a claim response that somehow lacks it must fail the
// deploy loudly rather than deploy a container that cannot authenticate.
func TestParseRunnerDeployConfig_RequiresClaimTimeToken(t *testing.T) {
	stored := map[string]any{"runner_id": "r1", "runner_name": "edge", "region": "us-east-1"}
	if _, err := parseRunnerDeployConfig(stored); err == nil {
		t.Fatal("a snapshot without the claim-time token must not parse as a deploy config")
	}
}
