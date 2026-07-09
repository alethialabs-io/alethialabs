// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type stubAwsFetcher struct {
	mu    sync.Mutex
	fed   *AwsFederation
	err   error
	calls int
}

func (s *stubAwsFetcher) FetchAwsToken() (*AwsFederation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return s.fed, nil
}

func (s *stubAwsFetcher) setToken(tok string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fed = &AwsFederation{Token: tok, PlatformRoleArn: s.fed.PlatformRoleArn, Region: s.fed.Region}
}

func (s *stubAwsFetcher) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func TestActivateAwsFederated_WritesChainedProfileAndCleansUp(t *testing.T) {
	fetcher := &stubAwsFetcher{fed: &AwsFederation{
		Token:           "web.identity.jwt",
		PlatformRoleArn: "arn:aws:iam::270587882865:role/alethia-connector-assumer",
		Region:          "eu-central-1",
	}}
	// A stale static key must be cleared so the profile chain is authoritative.
	os.Setenv("AWS_ACCESS_KEY_ID", "stale")
	defer os.Unsetenv("AWS_ACCESS_KEY_ID")

	cleanup, err := ActivateAwsFederated(context.Background(), fetcher, "arn:aws:iam::111122223333:role/AlethiaProvisionerRole-abc", "ext-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if os.Getenv("AWS_PROFILE") != awsCustomerProfile {
		t.Errorf("AWS_PROFILE = %q, want %q", os.Getenv("AWS_PROFILE"), awsCustomerProfile)
	}
	if os.Getenv("AWS_ACCESS_KEY_ID") != "" {
		t.Error("a stale AWS_ACCESS_KEY_ID should be cleared so the profile chain wins")
	}
	if os.Getenv("AWS_REGION") != "eu-central-1" {
		t.Errorf("AWS_REGION = %q, want eu-central-1", os.Getenv("AWS_REGION"))
	}

	configPath := os.Getenv("AWS_CONFIG_FILE")
	if configPath == "" {
		t.Fatal("AWS_CONFIG_FILE should be set")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("config file should exist: %v", err)
	}
	cfg := string(data)
	for _, want := range []string{
		"[profile " + awsPlatformProfile + "]",
		"web_identity_token_file = ",
		"role_arn = arn:aws:iam::270587882865:role/alethia-connector-assumer",
		"[profile " + awsCustomerProfile + "]",
		"source_profile = " + awsPlatformProfile,
		"role_arn = arn:aws:iam::111122223333:role/AlethiaProvisionerRole-abc",
		"external_id = ext-123",
	} {
		if !strings.Contains(cfg, want) {
			t.Errorf("config file missing %q\n---\n%s", want, cfg)
		}
	}

	cleanup()
	if os.Getenv("AWS_CONFIG_FILE") != "" || os.Getenv("AWS_PROFILE") != "" {
		t.Error("AWS_CONFIG_FILE / AWS_PROFILE should be cleared after cleanup")
	}
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Error("the temp creds dir should be removed after cleanup")
	}
}

func TestActivateAwsFederated_OmitsExternalIdWhenEmpty(t *testing.T) {
	fetcher := &stubAwsFetcher{fed: &AwsFederation{Token: "t", PlatformRoleArn: "arn:aws:iam::270587882865:role/p"}}
	cleanup, err := ActivateAwsFederated(context.Background(), fetcher, "arn:aws:iam::111122223333:role/c", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer cleanup()
	data, _ := os.ReadFile(os.Getenv("AWS_CONFIG_FILE"))
	if strings.Contains(string(data), "external_id") {
		t.Error("external_id should be omitted when the identity has none")
	}
}

func TestActivateAwsFederated_Errors(t *testing.T) {
	// Missing role_arn.
	if _, err := ActivateAwsFederated(context.Background(), &stubAwsFetcher{fed: &AwsFederation{}}, "", "x"); err == nil {
		t.Error("expected an error when role_arn is missing")
	}
	// Mint failure.
	if _, err := ActivateAwsFederated(context.Background(), &stubAwsFetcher{err: fmt.Errorf("issuer down")}, "arn:role", "x"); err == nil {
		t.Error("expected an error when the token mint fails")
	}
	// No platform role in the response.
	if _, err := ActivateAwsFederated(context.Background(), &stubAwsFetcher{fed: &AwsFederation{Token: "t"}}, "arn:role", "x"); err == nil {
		t.Error("expected an error when the platform role ARN is absent")
	}
}

func TestRefreshAwsToken_RewritesFileAndStopsOnCancel(t *testing.T) {
	dir := t.TempDir()
	tokenPath := dir + "/token"
	if err := os.WriteFile(tokenPath, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	fetcher := &stubAwsFetcher{fed: &AwsFederation{Token: "second", PlatformRoleArn: "arn:aws:iam::270587882865:role/p"}}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		refreshAwsToken(ctx, fetcher, tokenPath, 5*time.Millisecond)
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

	if fetcher.callCount() == 0 {
		t.Error("expected the refresher to have fetched at least once")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("refresher did not stop on context cancel")
	}
}
