// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestDeployPayloadRoundTrip is the anti-divergence guard: the container path serializes
// the payload to JSON, and ProjectConfig's json:"-" fields (CloudAccountID,
// ConnectorCredentials) would silently vanish unless carried explicitly. The git token
// must NOT appear in the serialized payload (it crosses via the child's env).
func TestDeployPayloadRoundTrip(t *testing.T) {
	vc := &types.ProjectConfig{
		ProjectName:          "web",
		GitAccessToken:       "ghp_secret",
		CloudAccountID:       "123456789012",
		ConnectorCredentials: []types.ConnectorCredential{{Category: "dns", Slug: "cloudflare", Credentials: map[string]string{"api_token": "cf_secret"}}},
	}

	payload := buildDeployPayload(vc, "aws", false, "", "/tpl", "/cat", "", nil, "https://console", "job-1")

	// buildDeployPayload must not mutate the caller's config.
	if vc.GitAccessToken != "ghp_secret" {
		t.Error("buildDeployPayload mutated the caller's ProjectConfig")
	}
	// git token blanked in the payload's ProjectConfig; json:"-" fields carried explicitly.
	if payload.ProjectConfig.GitAccessToken != "" {
		t.Error("git token must be blanked in the payload ProjectConfig (crosses via env)")
	}
	if payload.CloudAccountID != "123456789012" || len(payload.ConnectorCredentials) != 1 {
		t.Fatalf("json:- fields not carried explicitly: acct=%q creds=%d", payload.CloudAccountID, len(payload.ConnectorCredentials))
	}

	// Survive the JSON round-trip the container backend performs.
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(b); containsAny(got, "ghp_secret") {
		t.Error("serialized payload must not contain the git token")
	}
	var got stageDeployPayload
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}

	// The nested ProjectConfig drops ConnectorCredentials/CloudAccountID (json:"-")...
	if len(got.ProjectConfig.ConnectorCredentials) != 0 || got.ProjectConfig.CloudAccountID != "" {
		t.Error("expected nested ProjectConfig json:- fields to be dropped by serialization")
	}
	// ...but the explicit payload fields survive.
	if got.CloudAccountID != "123456789012" {
		t.Error("CloudAccountID lost across serialization")
	}
	if len(got.ConnectorCredentials) != 1 || got.ConnectorCredentials[0].Slug != "cloudflare" ||
		got.ConnectorCredentials[0].Credentials["api_token"] != "cf_secret" {
		t.Fatalf("ConnectorCredentials lost across serialization: %+v", got.ConnectorCredentials)
	}

	// Reattach mirrors runDeployStage: the reconstructed config is whole again.
	vc2 := got.ProjectConfig
	vc2.CloudAccountID = got.CloudAccountID
	vc2.ConnectorCredentials = got.ConnectorCredentials
	if vc2.CloudAccountID != "123456789012" || len(vc2.ConnectorCredentials) != 1 {
		t.Error("reattach failed to restore the json:- fields")
	}
}

func containsAny(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
