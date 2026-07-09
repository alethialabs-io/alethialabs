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

type stubAlibabaFetcher struct {
	mu    sync.Mutex
	token string
	err   error
	calls int
}

func (s *stubAlibabaFetcher) FetchAlibabaToken() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.token, s.err
}

func (s *stubAlibabaFetcher) setToken(t string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token = t
}

func (s *stubAlibabaFetcher) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func TestActivateAlibabaOIDC_SetsEnvFileAndCleansUp(t *testing.T) {
	fetcher := &stubAlibabaFetcher{token: "minted.oidc.jwt"}
	// A stale AK must be cleared so the OIDC chain is authoritative.
	os.Setenv("ALICLOUD_ACCESS_KEY", "stale")
	defer os.Unsetenv("ALICLOUD_ACCESS_KEY")

	cleanup, err := ActivateAlibabaOIDC(context.Background(), fetcher, "acs:ram::111122223333:role/AlethiaProvisioner", "acs:ram::111122223333:oidc-provider/alethia")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fetcher.callCount() != 1 {
		t.Errorf("expected the token to be fetched once, got %d", fetcher.callCount())
	}

	// The alicloud provider resolves AssumeRoleWithOIDC from these (no AccessKey).
	if os.Getenv("ALIBABA_CLOUD_ROLE_ARN") != "acs:ram::111122223333:role/AlethiaProvisioner" {
		t.Error("ALIBABA_CLOUD_ROLE_ARN should be the customer role")
	}
	if os.Getenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN") != "acs:ram::111122223333:oidc-provider/alethia" {
		t.Error("ALIBABA_CLOUD_OIDC_PROVIDER_ARN should be the RAM OIDC provider")
	}
	if os.Getenv("ALICLOUD_ACCESS_KEY") != "" {
		t.Error("a stale ALICLOUD_ACCESS_KEY should be cleared so the OIDC chain wins")
	}

	tokenPath := os.Getenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE")
	if tokenPath == "" {
		t.Fatal("ALIBABA_CLOUD_OIDC_TOKEN_FILE should point at the token file")
	}
	data, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("token file should exist: %v", err)
	}
	if string(data) != "minted.oidc.jwt" {
		t.Errorf("token file content = %q, want the minted token", string(data))
	}

	cleanup()
	for _, k := range []string{"ALIBABA_CLOUD_ROLE_ARN", "ALIBABA_CLOUD_OIDC_PROVIDER_ARN", "ALIBABA_CLOUD_OIDC_TOKEN_FILE"} {
		if os.Getenv(k) != "" {
			t.Errorf("%s should be cleared after cleanup", k)
		}
	}
	if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
		t.Error("token file should be removed after cleanup")
	}
}

func TestActivateAlibabaOIDC_Errors(t *testing.T) {
	fetcher := &stubAlibabaFetcher{token: "x"}
	// Missing oidc_provider_arn.
	if _, err := ActivateAlibabaOIDC(context.Background(), fetcher, "acs:ram::1:role/r", ""); err == nil {
		t.Error("expected an error when the oidc_provider_arn is missing")
	}
	if fetcher.callCount() != 0 {
		t.Error("should not fetch a token when the identity is incomplete")
	}
	// Mint failure.
	failing := &stubAlibabaFetcher{err: fmt.Errorf("issuer down")}
	if _, err := ActivateAlibabaOIDC(context.Background(), failing, "acs:ram::1:role/r", "acs:ram::1:oidc-provider/alethia"); err == nil {
		t.Error("expected an error when the token mint fails")
	}
}

func TestRefreshAlibabaToken_RewritesFileAndStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	tokenPath := dir + "/token.jwt"
	if err := os.WriteFile(tokenPath, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	fetcher := &stubAlibabaFetcher{token: "second"}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		refreshAlibabaToken(ctx, fetcher, tokenPath, 5*time.Millisecond)
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
