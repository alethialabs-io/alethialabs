// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

type stubAzureFetcher struct {
	mu    sync.Mutex
	token string
	err   error
	calls int
}

func (s *stubAzureFetcher) FetchAzureToken(jobID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.token, s.err
}

func (s *stubAzureFetcher) setToken(t string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token = t
}

func (s *stubAzureFetcher) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func TestActivateAzureFederated_SetsEnvAndCleansUp(t *testing.T) {
	fetcher := &stubAzureFetcher{token: "minted.jwt.token"}
	cleanup, err := ActivateAzureFederated(context.Background(), fetcher, "tenant-1", "client-1", "sub-1", "job-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fetcher.callCount() != 1 {
		t.Errorf("expected the token to be fetched once, got %d", fetcher.callCount())
	}

	// azurerm (OpenTofu) reads these; the FILE path (not a literal token) drives the keyless exchange so
	// the provider re-reads a refreshed assertion.
	if os.Getenv("ARM_USE_OIDC") != "true" {
		t.Error("ARM_USE_OIDC should be true")
	}
	// The literal ARM_OIDC_TOKEN must NOT be set — azurerm would prefer it and never re-read the file.
	if os.Getenv("ARM_OIDC_TOKEN") != "" {
		t.Error("ARM_OIDC_TOKEN (literal) should not be set — the file path is the source of truth")
	}
	if os.Getenv("ARM_OIDC_TOKEN_FILE_PATH") == "" {
		t.Error("ARM_OIDC_TOKEN_FILE_PATH should point at the token file")
	}
	if os.Getenv("ARM_CLIENT_ID") != "client-1" || os.Getenv("ARM_TENANT_ID") != "tenant-1" ||
		os.Getenv("ARM_SUBSCRIPTION_ID") != "sub-1" {
		t.Error("ARM_* identity vars should be set from the identity")
	}

	tokenPath := os.Getenv("AZURE_FEDERATED_TOKEN_FILE")
	if tokenPath == "" {
		t.Fatal("AZURE_FEDERATED_TOKEN_FILE should point at the token file")
	}
	if tokenPath != os.Getenv("ARM_OIDC_TOKEN_FILE_PATH") {
		t.Error("the ARM + AZURE file-path vars should point at the same token file")
	}
	data, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("token file should exist: %v", err)
	}
	if string(data) != "minted.jwt.token" {
		t.Errorf("token file content = %q, want the minted token", string(data))
	}

	cleanup()

	for _, k := range []string{"ARM_USE_OIDC", "ARM_OIDC_TOKEN_FILE_PATH", "ARM_CLIENT_ID", "AZURE_FEDERATED_TOKEN_FILE"} {
		if os.Getenv(k) != "" {
			t.Errorf("%s should be cleared after cleanup", k)
		}
	}
	if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
		t.Error("token file should be removed after cleanup")
	}
}

func TestActivateAzureFederated_FetchError(t *testing.T) {
	fetcher := &stubAzureFetcher{err: fmt.Errorf("issuer down")}
	if _, err := ActivateAzureFederated(context.Background(), fetcher, "tenant-1", "client-1", "sub-1", "job-1"); err == nil {
		t.Error("expected an error when the token mint fails")
	}
}

func TestActivateAzureFederated_MissingIdentity(t *testing.T) {
	fetcher := &stubAzureFetcher{token: "x"}
	if _, err := ActivateAzureFederated(context.Background(), fetcher, "", "client-1", "sub-1", "job-1"); err == nil {
		t.Error("expected an error when tenant_id is missing")
	}
	if fetcher.callCount() != 0 {
		t.Error("should not fetch a token when the identity is incomplete")
	}
}

// The refresher must re-mint into the token file so a long apply keeps a live assertion, and it must stop
// when the job context is cancelled.
func TestRefreshAzureToken_RewritesFileAndStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	tokenPath := dir + "/token.jwt"
	if err := os.WriteFile(tokenPath, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	fetcher := &stubAzureFetcher{token: "second"}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		refreshAzureToken(ctx, fetcher, tokenPath, 5*time.Millisecond, "job-1")
		close(done)
	}()

	// Wait until the file is rewritten with a freshly-minted token.
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

	// A transient fetch error must not clobber the good token on disk.
	fetcher.setToken("")
	fetcher.mu.Lock()
	fetcher.err = fmt.Errorf("issuer blip")
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
