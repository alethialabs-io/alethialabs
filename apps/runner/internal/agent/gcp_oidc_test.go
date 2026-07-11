// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

type stubGcpFetcher struct {
	mu    sync.Mutex
	token string
	err   error
}

func (s *stubGcpFetcher) FetchGcpToken(jobID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token, s.err
}

func (s *stubGcpFetcher) setToken(t string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token = t
}

const oidcWifJSON = `{"type":"external_account","audience":"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/alethia-pool/providers/alethia-oidc-provider","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken","credential_source":{"file":"/var/run/alethia/gcp-oidc-token","format":{"type":"text"}}}`

const legacyWifJSON = `{"type":"external_account","subject_token_type":"urn:ietf:params:aws:token-type:aws4_request","credential_source":{"environment_id":"aws1"}}`

func TestIsOidcWifJSON(t *testing.T) {
	if !isOidcWifJSON(oidcWifJSON) {
		t.Error("expected the jwt config to be detected as direct-OIDC")
	}
	if isOidcWifJSON(legacyWifJSON) {
		t.Error("the aws4_request config must NOT be treated as direct-OIDC")
	}
	if isOidcWifJSON("not json") {
		t.Error("malformed config must fall back to legacy (false)")
	}
}

func TestInjectGcpTokenFile(t *testing.T) {
	out, err := injectGcpTokenFile(oidcWifJSON, "/tmp/my-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatal(err)
	}
	cs := m["credential_source"].(map[string]any)
	if cs["file"] != "/tmp/my-token" {
		t.Errorf("credential_source.file = %v, want /tmp/my-token", cs["file"])
	}
	if _, ok := cs["format"]; !ok {
		t.Error("format should be preserved/defaulted")
	}
	// The audience/impersonation URL must be preserved.
	if m["audience"] == nil || m["service_account_impersonation_url"] == nil {
		t.Error("injectGcpTokenFile dropped required fields")
	}
}

func TestActivateGcpOIDC_WritesTokenAndWifAndCleansUp(t *testing.T) {
	fetcher := &stubGcpFetcher{token: "minted.gcp.jwt"}
	cleanup, err := ActivateGcpOIDC(context.Background(), fetcher, oidcWifJSON, "my-proj", "job-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	credPath := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")
	if credPath == "" {
		t.Fatal("GOOGLE_APPLICATION_CREDENTIALS should be set")
	}
	// The written WIF config's credential_source.file should point at a real token file holding the token.
	data, err := os.ReadFile(credPath)
	if err != nil {
		t.Fatalf("wif config file should exist: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	tokenPath, _ := m["credential_source"].(map[string]any)["file"].(string)
	if tokenPath == "" {
		t.Fatal("credential_source.file was not set to the runtime token file")
	}
	tok, err := os.ReadFile(tokenPath)
	if err != nil || string(tok) != "minted.gcp.jwt" {
		t.Errorf("token file = %q (err %v), want the minted token", string(tok), err)
	}

	cleanup()
	if os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" {
		t.Error("GOOGLE_APPLICATION_CREDENTIALS should be cleared after cleanup")
	}
	if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
		t.Error("token file should be removed after cleanup")
	}
}

func TestActivateGcpOIDC_MintError(t *testing.T) {
	if _, err := ActivateGcpOIDC(context.Background(), &stubGcpFetcher{err: fmt.Errorf("issuer down")}, oidcWifJSON, "p", "job-1"); err == nil {
		t.Error("expected an error when the token mint fails")
	}
}

func TestRefreshGcpToken_RewritesAndStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	tokenPath := dir + "/token"
	if err := os.WriteFile(tokenPath, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	fetcher := &stubGcpFetcher{token: "second"}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		refreshGcpToken(ctx, fetcher, tokenPath, 5*time.Millisecond, "job-1")
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for {
		data, _ := os.ReadFile(tokenPath)
		if string(data) == "second" {
			break
		}
		select {
		case <-deadline:
			t.Fatal("refresher never rewrote the token file")
		case <-time.After(2 * time.Millisecond):
		}
	}

	// A transient failure leaves the last good token.
	fetcher.setToken("")
	fetcher.mu.Lock()
	fetcher.err = fmt.Errorf("blip")
	fetcher.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	if data, _ := os.ReadFile(tokenPath); string(data) != "second" {
		t.Errorf("a failed mint should leave the last good token, got %q", string(data))
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("refresher did not stop on context cancel")
	}
}
