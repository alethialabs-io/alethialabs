// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stubGcpAwsFetcher satisfies awsTokenFetcher for the GCP platform-source path.
type stubGcpAwsFetcher struct {
	mu  sync.Mutex
	fed *AwsFederation
	err error
}

func (s *stubGcpAwsFetcher) FetchAwsToken() (*AwsFederation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	return s.fed, nil
}

// withStubAssume swaps the web-identity exchange for the duration of a test.
func withStubAssume(t *testing.T, fn func(ctx context.Context, region, roleArn, token string) (platformAwsCreds, error)) {
	t.Helper()
	prev := webIdentityAssume
	webIdentityAssume = fn
	t.Cleanup(func() { webIdentityAssume = prev })
}

func TestActivateGcpWIF_WritesRecipeAndCleansUp(t *testing.T) {
	cleanup, err := ActivateGcpWIF(`{"type":"external_account"}`, "my-proj")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	path := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")
	if path == "" {
		t.Fatal("GOOGLE_APPLICATION_CREDENTIALS should be set")
	}
	if os.Getenv("GOOGLE_PROJECT") != "my-proj" {
		t.Error("GOOGLE_PROJECT should be set")
	}
	if data, _ := os.ReadFile(path); string(data) != `{"type":"external_account"}` {
		t.Error("WIF recipe should be written verbatim")
	}
	cleanup()
	if os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" {
		t.Error("GOOGLE_APPLICATION_CREDENTIALS should be cleared")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("WIF file should be removed after cleanup")
	}
}

func TestActivateGcpPlatformSource_SetsAwsEnvAndCleansUp(t *testing.T) {
	withStubAssume(t, func(_ context.Context, _, roleArn, token string) (platformAwsCreds, error) {
		if roleArn != "arn:aws:iam::270587882865:role/alethia-connector-assumer" || token != "web.jwt" {
			t.Errorf("assume called with role=%q token=%q", roleArn, token)
		}
		return platformAwsCreds{"AKIA_TEST", "secret", "session"}, nil
	})
	fetcher := &stubGcpAwsFetcher{fed: &AwsFederation{
		Token:           "web.jwt",
		PlatformRoleArn: "arn:aws:iam::270587882865:role/alethia-connector-assumer",
		Region:          "eu-central-1",
	}}

	cleanup, err := ActivateGcpPlatformSource(context.Background(), fetcher)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if os.Getenv("AWS_ACCESS_KEY_ID") != "AKIA_TEST" || os.Getenv("AWS_SESSION_TOKEN") != "session" {
		t.Error("AWS_* source env should be set from the assumed platform creds")
	}
	if os.Getenv("AWS_REGION") != "eu-central-1" {
		t.Error("AWS_REGION should be set")
	}
	cleanup()
	for _, k := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"} {
		if os.Getenv(k) != "" {
			t.Errorf("%s should be cleared after cleanup", k)
		}
	}
}

func TestActivateGcpPlatformSource_Errors(t *testing.T) {
	// Mint failure.
	if _, err := ActivateGcpPlatformSource(context.Background(), &stubGcpAwsFetcher{err: fmt.Errorf("issuer down")}); err == nil {
		t.Error("expected an error when the token mint fails")
	}
	// No platform role in the response.
	withStubAssume(t, func(context.Context, string, string, string) (platformAwsCreds, error) {
		t.Error("assume should not be called without a platform role ARN")
		return platformAwsCreds{}, nil
	})
	if _, err := ActivateGcpPlatformSource(context.Background(), &stubGcpAwsFetcher{fed: &AwsFederation{Token: "t"}}); err == nil {
		t.Error("expected an error when the platform role ARN is absent")
	}
}

func TestRefreshGcpPlatformSource_ReassumesAndStopsOnCancel(t *testing.T) {
	var assumeCalls atomic.Int32
	withStubAssume(t, func(context.Context, string, string, string) (platformAwsCreds, error) {
		assumeCalls.Add(1)
		return platformAwsCreds{"AKIA", "s", "tok"}, nil
	})
	fetcher := &stubGcpAwsFetcher{fed: &AwsFederation{Token: "t", PlatformRoleArn: "arn:aws:iam::270587882865:role/p"}}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		refreshGcpPlatformSource(ctx, fetcher, 5*time.Millisecond)
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for assumeCalls.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("refresher only re-assumed %d times", assumeCalls.Load())
		case <-time.After(2 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("refresher did not stop on context cancel")
	}
	os.Unsetenv("AWS_ACCESS_KEY_ID")
	os.Unsetenv("AWS_SECRET_ACCESS_KEY")
	os.Unsetenv("AWS_SESSION_TOKEN")
}
