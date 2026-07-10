// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"time"
)

// alibabaTokenFetcher mints a keyless Alibaba OIDC assertion. Satisfied by *RunnerAPIClient
// (FetchAlibabaToken); an interface so the activation is unit-testable with a stub.
type alibabaTokenFetcher interface {
	FetchAlibabaToken(jobID string) (string, error)
}

// alibabaRefreshInterval mirrors AWS/Azure: re-mint the ≤10-min assertion into the token file every 5 min
// so the alicloud provider always re-reads a live token when it re-runs AssumeRoleWithOIDC.
const alibabaRefreshInterval = 5 * time.Minute

// ActivateAlibabaOIDC authenticates the runner to Alibaba KEYLESSLY for a `tofu apply`. Alibaba retired the
// platform RAM AccessKey: the alicloud provider does an anonymous **AssumeRoleWithOIDC** itself, reading a
// short-lived assertion from a FILE (ALIBABA_CLOUD_OIDC_TOKEN_FILE) plus the role + OIDC-provider ARNs.
// The runner fetches the assertion from the console (the issuer key holder), writes it to the file, and
// sets the env the provider reads — no AccessKey anywhere. Because the provider re-reads the file, a
// background refresher re-mints the assertion every few minutes so applies past the 1h session survive
// (parity with AWS/Azure). cleanup stops the refresher, unsets the vars, and removes the temp file.
func ActivateAlibabaOIDC(ctx context.Context, fetcher alibabaTokenFetcher, roleArn, oidcProviderArn, jobID string) (func(), error) {
	if roleArn == "" || oidcProviderArn == "" {
		return nil, fmt.Errorf("missing Alibaba role_arn or oidc_provider_arn")
	}
	if fetcher == nil {
		return nil, fmt.Errorf("no token fetcher for Alibaba federation")
	}

	token, err := fetcher.FetchAlibabaToken(jobID)
	if err != nil {
		return nil, fmt.Errorf("failed to mint Alibaba OIDC token: %w", err)
	}

	tokenFile, err := os.CreateTemp("", "alethia-alibaba-oidc-*.jwt")
	if err != nil {
		return nil, fmt.Errorf("failed to create Alibaba token file: %w", err)
	}
	tokenPath := tokenFile.Name()
	if _, err := tokenFile.WriteString(token); err != nil {
		tokenFile.Close()
		os.Remove(tokenPath)
		return nil, fmt.Errorf("failed to write Alibaba token file: %w", err)
	}
	tokenFile.Close()

	// The alicloud provider / aliyun CLI resolve AssumeRoleWithOIDC from these (the darabonba default
	// credential chain). No ALICLOUD_ACCESS_KEY — clear any stale AK so the OIDC chain is authoritative.
	os.Setenv("ALIBABA_CLOUD_ROLE_ARN", roleArn)
	os.Setenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN", oidcProviderArn)
	os.Setenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE", tokenPath)
	os.Setenv("ALIBABA_CLOUD_ROLE_SESSION_NAME", "alethia-runner")
	os.Unsetenv("ALICLOUD_ACCESS_KEY")
	os.Unsetenv("ALICLOUD_SECRET_KEY")
	os.Unsetenv("ALICLOUD_SECURITY_TOKEN")

	refreshCtx, cancel := context.WithCancel(ctx)
	go refreshAlibabaToken(refreshCtx, fetcher, tokenPath, alibabaRefreshInterval, jobID)

	cleanup := func() {
		cancel()
		for _, k := range []string{
			"ALIBABA_CLOUD_ROLE_ARN", "ALIBABA_CLOUD_OIDC_PROVIDER_ARN",
			"ALIBABA_CLOUD_OIDC_TOKEN_FILE", "ALIBABA_CLOUD_ROLE_SESSION_NAME",
		} {
			os.Unsetenv(k)
		}
		os.Remove(tokenPath)
	}
	return cleanup, nil
}

// refreshAlibabaToken re-mints the OIDC assertion into tokenPath every interval until ctx is cancelled. A
// transient mint failure is left to the next tick — the provider only re-reads the file when it re-assumes
// (roughly hourly) — so a good token is never clobbered by an error.
func refreshAlibabaToken(ctx context.Context, fetcher alibabaTokenFetcher, tokenPath string, interval time.Duration, jobID string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			token, err := fetcher.FetchAlibabaToken(jobID)
			if err != nil || token == "" {
				continue
			}
			_ = writeTokenFileAtomic(tokenPath, token)
		}
	}
}
