// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// AwsFederation is what the console's /api/runners/aws-token returns: a short-lived OIDC assertion plus the
// platform role ARN the runner assumes via web identity (and the region for the SDK).
type AwsFederation struct {
	Token           string
	PlatformRoleArn string
	Region          string
}

// awsTokenFetcher mints a keyless AWS federation assertion. Satisfied by *RunnerAPIClient (FetchAwsToken);
// an interface so the activation is unit-testable with a stub.
type awsTokenFetcher interface {
	FetchAwsToken() (*AwsFederation, error)
}

// awsRefreshInterval mirrors Azure: re-mint the ≤10-min web-identity assertion into the token file every
// 5 min so the AWS SDK always re-reads a live token when it refreshes the ~1h assumed-role sessions.
const awsRefreshInterval = 5 * time.Minute

// AWS shared-config profile names the runner writes. The customer profile chains OFF the platform profile.
const (
	awsPlatformProfile = "alethia-platform"
	awsCustomerProfile = "alethia-customer"
)

// ActivateAwsFederated authenticates a MANAGED runner to AWS KEYLESSLY for a `tofu apply`. The runner has
// no ambient AWS identity, so it:
//  1. mints a web-identity assertion (audience sts.amazonaws.com) from the console and writes it to a file;
//  2. writes an AWS shared-config file with two chained profiles —
//     [profile alethia-platform]  web_identity_token_file → role_arn = <platform role>   (AssumeRoleWithWebIdentity)
//     [profile alethia-customer]  source_profile = alethia-platform, role_arn = <customer role>, external_id = <X>
//  3. points the AWS SDK / OpenTofu's aws provider at it (AWS_CONFIG_FILE + AWS_PROFILE=alethia-customer).
//
// Because the whole chain resolves from a *file* the SDK re-reads, both hops auto-refresh: a background
// refresher re-mints the assertion every few minutes and the SDK re-assumes on session expiry — so an
// apply longer than the 1h session survives. The customer ExternalId stays on the customer hop (it can't
// be expressed on AssumeRoleWithWebIdentity). No access key is ever present. cleanup stops the refresher,
// unsets the vars, and removes the temp files.
func ActivateAwsFederated(ctx context.Context, fetcher awsTokenFetcher, customerRoleArn, externalID string) (func(), error) {
	if customerRoleArn == "" {
		return nil, fmt.Errorf("missing AWS role_arn")
	}
	if fetcher == nil {
		return nil, fmt.Errorf("no token fetcher for AWS federation")
	}

	fed, err := fetcher.FetchAwsToken()
	if err != nil {
		return nil, fmt.Errorf("failed to mint AWS federation token: %w", err)
	}
	if fed.PlatformRoleArn == "" {
		return nil, fmt.Errorf("AWS federation response had no platform role ARN")
	}

	dir, err := os.MkdirTemp("", "alethia-aws-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create AWS creds dir: %w", err)
	}
	tokenPath := filepath.Join(dir, "web-identity-token")
	configPath := filepath.Join(dir, "config")

	if err := writeTokenFileAtomic(tokenPath, fed.Token); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("failed to write AWS token file: %w", err)
	}
	if err := os.WriteFile(configPath, []byte(awsConfigFile(tokenPath, fed.PlatformRoleArn, customerRoleArn, externalID)), 0o600); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("failed to write AWS config file: %w", err)
	}

	// Point the SDK / aws provider at the chained profile. Clear any static creds so the profile chain
	// (not a stale key) is authoritative, and enable shared-config resolution.
	os.Setenv("AWS_CONFIG_FILE", configPath)
	os.Setenv("AWS_PROFILE", awsCustomerProfile)
	os.Setenv("AWS_SDK_LOAD_CONFIG", "1")
	if fed.Region != "" {
		os.Setenv("AWS_REGION", fed.Region)
	}
	os.Unsetenv("AWS_ACCESS_KEY_ID")
	os.Unsetenv("AWS_SECRET_ACCESS_KEY")
	os.Unsetenv("AWS_SESSION_TOKEN")

	refreshCtx, cancel := context.WithCancel(ctx)
	go refreshAwsToken(refreshCtx, fetcher, tokenPath, awsRefreshInterval)

	cleanup := func() {
		cancel()
		for _, k := range []string{
			"AWS_CONFIG_FILE", "AWS_PROFILE", "AWS_SDK_LOAD_CONFIG", "AWS_REGION",
		} {
			os.Unsetenv(k)
		}
		os.RemoveAll(dir)
	}
	return cleanup, nil
}

// awsConfigFile renders the two-profile shared-config that chains the customer role off the web-identity
// platform role. Rendered verbatim into AWS_CONFIG_FILE.
func awsConfigFile(tokenPath, platformRoleArn, customerRoleArn, externalID string) string {
	cfg := fmt.Sprintf(`[profile %s]
web_identity_token_file = %s
role_arn = %s
role_session_name = alethia-platform

[profile %s]
source_profile = %s
role_arn = %s
role_session_name = alethia-runner
`, awsPlatformProfile, tokenPath, platformRoleArn, awsCustomerProfile, awsPlatformProfile, customerRoleArn)
	if externalID != "" {
		cfg += fmt.Sprintf("external_id = %s\n", externalID)
	}
	return cfg
}

// refreshAwsToken re-mints the web-identity assertion into tokenPath every interval until ctx is cancelled.
// A transient mint failure is left to the next tick — the SDK only re-reads the file when it re-assumes
// (roughly hourly) — so a good token is never clobbered by an error.
func refreshAwsToken(ctx context.Context, fetcher awsTokenFetcher, tokenPath string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fed, err := fetcher.FetchAwsToken()
			if err != nil || fed == nil || fed.Token == "" {
				continue
			}
			_ = writeTokenFileAtomic(tokenPath, fed.Token)
		}
	}
}
