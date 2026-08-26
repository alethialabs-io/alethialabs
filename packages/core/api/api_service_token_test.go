// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Service-account tokens — the client half of non-interactive `alethia` authentication.

func TestListServiceTokens_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/tokens" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tokens": []map[string]any{
				{"id": "t1", "name": "github-actions", "token_prefix": "alethia_sat_abc12345", "created_at": "2026-08-26T09:00:00Z"},
				{"id": "t2", "name": "nightly", "token_prefix": "alethia_sat_def67890", "created_at": "2026-08-25T09:00:00Z", "revoked_at": "2026-08-26T08:00:00Z"},
			},
		})
	}))

	tokens, err := client.ListServiceTokens()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tokens) != 2 {
		t.Fatalf("got %d tokens, want 2", len(tokens))
	}
	if tokens[0].Name != "github-actions" || tokens[0].TokenPrefix != "alethia_sat_abc12345" {
		t.Errorf("unexpected first token: %+v", tokens[0])
	}
	// A REVOKED token is still listed. One that vanished from the list would take its audit trail
	// with it, and "this one was revoked on the 26th" is the fact an incident needs.
	if tokens[1].RevokedAt == nil || *tokens[1].RevokedAt == "" {
		t.Errorf("a revoked token lost its revoked_at: %+v", tokens[1])
	}
	// Absent optional timestamps stay nil rather than becoming "", so a never-used token is
	// distinguishable from one used at the zero time.
	if tokens[0].LastUsedAt != nil {
		t.Errorf("an unused token reported last_used_at = %v, want nil", *tokens[0].LastUsedAt)
	}
}

func TestListServiceTokens_Error(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "forbidden"})
	}))
	if _, err := client.ListServiceTokens(); err == nil {
		t.Fatal("a 403 returned no error")
	}
}

func TestCreateServiceToken_Success(t *testing.T) {
	var body map[string]any
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/tokens" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "t1", "name": "ci", "token_prefix": "alethia_sat_abc12345",
			"token":   "alethia_sat_abc12345the-rest-of-it",
			"warning": "Copy this token now — it is not stored and cannot be shown again.",
		})
	}))

	created, err := client.CreateServiceToken("ci", 90)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if body["name"] != "ci" {
		t.Errorf("name not sent: %+v", body)
	}
	if body["expires_in_days"] != float64(90) {
		t.Errorf("expires_in_days not sent: %+v", body)
	}
	// The mint response is the ONLY place the plaintext exists.
	if !strings.HasPrefix(created.Token, "alethia_sat_") {
		t.Errorf("the minted token is not prefixed: %q", created.Token)
	}
	if created.Warning == "" {
		t.Error("the once-only warning was dropped — a client storing this response should be told")
	}
}

// 0 means "never expires", and it must be OMITTED rather than sent as zero: the server reads a
// present `expires_in_days` as a positive integer, so sending 0 would be rejected as invalid rather
// than understood as no expiry.
func TestCreateServiceToken_OmitsZeroExpiry(t *testing.T) {
	var body map[string]any
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "t1", "name": "ci", "token": "alethia_sat_x"})
	}))
	if _, err := client.CreateServiceToken("ci", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, present := body["expires_in_days"]; present {
		t.Errorf("expires_in_days was sent for a non-expiring token: %+v", body)
	}
}

func TestCreateServiceToken_Error(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "a token needs a name"})
	}))
	if _, err := client.CreateServiceToken("", 0); err == nil {
		t.Fatal("a 400 returned no error")
	}
}

func TestRevokeServiceToken_Success(t *testing.T) {
	var gotPath, gotMethod string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		gotPath, gotMethod = r.URL.Path, r.Method
		_ = json.NewEncoder(w).Encode(map[string]any{"revoked": true, "id": "t1"})
	}))
	if err := client.RevokeServiceToken("t1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotPath != "/api/cli/tokens/t1" || gotMethod != http.MethodDelete {
		t.Errorf("unexpected %s %s", gotMethod, gotPath)
	}
}

// A token id arrives from a list the user is reading, so it should not be trusted into a URL
// unescaped — a `/` would silently address a different route.
func TestRevokeServiceToken_EscapesTheID(t *testing.T) {
	var gotPath string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(map[string]any{"revoked": true})
	}))
	if err := client.RevokeServiceToken("a/b"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(gotPath, "a/b") {
		t.Errorf("the id was not escaped into the path: %s", gotPath)
	}
}

func TestRevokeServiceToken_Error(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "No such active token"})
	}))
	if err := client.RevokeServiceToken("nope"); err == nil {
		t.Fatal("a 404 returned no error")
	}
}
