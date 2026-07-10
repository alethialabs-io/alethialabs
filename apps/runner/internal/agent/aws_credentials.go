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

// AwsFederation is what the console's /api/runners/aws-token returns: a short-lived OIDC assertion the
// runner exchanges DIRECTLY for the customer's role via AssumeRoleWithWebIdentity (and the region for the
// SDK). There is no platform AWS account in the path — the customer's role trusts the Alethia issuer.
type AwsFederation struct {
	Token  string
	Region string
}

// awsTokenFetcher mints a keyless AWS federation assertion. Satisfied by *RunnerAPIClient (FetchAwsToken);
// an interface so the activation is unit-testable with a stub.
type awsTokenFetcher interface {
	FetchAwsToken(jobID string) (*AwsFederation, error)
}

// awsRefreshInterval mirrors Azure: re-mint the ≤10-min web-identity assertion into the token file every
// 5 min so the AWS SDK always re-reads a live token when it refreshes the ~1h assumed-role session.
const awsRefreshInterval = 5 * time.Minute

// The AWS shared-config profile the runner writes (a single web-identity profile — no chaining).
const awsCustomerProfile = "alethia-customer"

// ActivateAwsFederated authenticates a MANAGED runner to AWS KEYLESSLY for a `tofu apply`. The runner has
// no ambient AWS identity, so it:
//  1. mints a web-identity assertion (audience sts.amazonaws.com) from the console and writes it to a file;
//  2. writes an AWS shared-config file with ONE profile that federates straight into the customer role —
//     [profile alethia-customer]  web_identity_token_file → role_arn = <customer role>   (AssumeRoleWithWebIdentity)
//  3. points the AWS SDK / OpenTofu's aws provider at it (AWS_CONFIG_FILE + AWS_PROFILE=alethia-customer).
//
// The customer role trusts the Alethia issuer directly (an IAM OIDC provider), so there is no platform AWS
// account and no ExternalId. Because the profile resolves from a *file* the SDK re-reads, it auto-refreshes:
// a background refresher re-mints the assertion every few minutes and the SDK re-assumes on session expiry —
// so an apply longer than the 1h session survives. No access key is ever present. cleanup stops the
// refresher, unsets the vars, and removes the temp files.
func ActivateAwsFederated(ctx context.Context, fetcher awsTokenFetcher, customerRoleArn, jobID string) (func(), error) {
	if customerRoleArn == "" {
		return nil, fmt.Errorf("missing AWS role_arn")
	}
	if fetcher == nil {
		return nil, fmt.Errorf("no token fetcher for AWS federation")
	}

	fed, err := fetcher.FetchAwsToken(jobID)
	if err != nil {
		return nil, fmt.Errorf("failed to mint AWS federation token: %w", err)
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
	if err := os.WriteFile(configPath, []byte(awsConfigFile(tokenPath, customerRoleArn)), 0o600); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("failed to write AWS config file: %w", err)
	}

	// Point the SDK / aws provider at the web-identity profile. Clear any static creds so the profile
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
	go refreshAwsToken(refreshCtx, fetcher, tokenPath, awsRefreshInterval, jobID)

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

// awsConfigFile renders the single web-identity profile that federates straight into the customer role.
// Rendered verbatim into AWS_CONFIG_FILE.
func awsConfigFile(tokenPath, customerRoleArn string) string {
	return fmt.Sprintf(`[profile %s]
web_identity_token_file = %s
role_arn = %s
role_session_name = alethia-runner
`, awsCustomerProfile, tokenPath, customerRoleArn)
}

// refreshAwsToken re-mints the web-identity assertion into tokenPath every interval until ctx is cancelled.
// A transient mint failure is left to the next tick — the SDK only re-reads the file when it re-assumes
// (roughly hourly) — so a good token is never clobbered by an error.
func refreshAwsToken(ctx context.Context, fetcher awsTokenFetcher, tokenPath string, interval time.Duration, jobID string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fed, err := fetcher.FetchAwsToken(jobID)
			if err != nil || fed == nil || fed.Token == "" {
				continue
			}
			_ = writeTokenFileAtomic(tokenPath, fed.Token)
		}
	}
}
