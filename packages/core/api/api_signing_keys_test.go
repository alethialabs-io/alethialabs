// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// GetSigningKeys serves the trusted-key set `alethia verify receipt` binds a receipt's key_id
// against (#2331). The path and the envelope are the contract: a wrong path 404s and the command
// degrades to "trust unavailable", which reads to a user as a verification problem rather than a
// client bug.
func TestGetSigningKeys(t *testing.T) {
	isolateConfigDir(t)
	var gotPath string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"signing_keys": []map[string]any{
				{
					"key_id": "0123456789abcdef", "public_key": "cHVi", "algorithm": "ed25519",
					"source": "org", "provider": "aws", "status": "active", "active": true,
				},
				{
					"key_id": "fedcba9876543210", "public_key": "cGxhdA==", "algorithm": "ed25519",
					"source": "platform", "provider": nil, "status": nil, "active": true,
				},
			},
		})
	}))

	keys, err := c.GetSigningKeys()
	if err != nil {
		t.Fatalf("GetSigningKeys: %v", err)
	}
	if gotPath != "/api/cli/signing-keys" {
		t.Errorf("wrong endpoint: %q", gotPath)
	}
	if len(keys) != 2 {
		t.Fatalf("want 2 keys, got %d", len(keys))
	}
	if keys[0].Source != "org" || keys[0].Provider != "aws" {
		t.Errorf("org key decoded wrong: %+v", keys[0])
	}
	// The platform entry carries JSON null for provider/status; those must land as empty strings
	// rather than failing the decode, or a verifier loses the platform key and can vouch for
	// nothing — every receipt today is platform-signed.
	if keys[1].Source != "platform" || keys[1].Provider != "" || keys[1].Status != "" {
		t.Errorf("platform key decoded wrong: %+v", keys[1])
	}
}

// An empty set is a legitimate answer (a deployment that signs nothing), and must not be an error
// — the caller decides what to do about it.
func TestGetSigningKeysEmpty(t *testing.T) {
	isolateConfigDir(t)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"signing_keys": []any{}})
	}))

	keys, err := c.GetSigningKeys()
	if err != nil {
		t.Fatalf("an empty key set is not an error: %v", err)
	}
	if len(keys) != 0 {
		t.Errorf("want no keys, got %d", len(keys))
	}
}
