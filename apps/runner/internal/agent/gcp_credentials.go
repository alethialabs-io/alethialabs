// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// gcpSourceRefreshInterval re-assumes the platform AWS source credential before its ~1h session expires, so
// each freshly-spawned tofu invocation (plan, then apply) gets a live source. NB: a single tofu subprocess
// captures the AWS_* env at spawn, so one continuous apply that runs past the ~1h source lifetime is the
// known limit — the proper long-term fix is a GCP WIF pool that trusts the Alethia OIDC issuer directly
// (a token file google-auth re-reads), removing the AWS hop entirely; tracked as a follow-up.
const gcpSourceRefreshInterval = 45 * time.Minute

// ActivateGcpWIF points OpenTofu's google provider at the customer's Workload-Identity-Federation config —
// a *recipe* file google-auth uses to exchange a subject token for a short-lived GCP access token. No
// service-account JSON key is ever written. For MANAGED runners the WIF subject token is signed with the
// platform AWS source credential (see ActivateGcpPlatformSource, called first); self-hosted runners rely on
// their own ambient GCP credentials.
func ActivateGcpWIF(wifConfigJSON string, projectID string) (func(), error) {
	if wifConfigJSON == "" {
		return nil, fmt.Errorf("empty WIF config")
	}

	tmpFile, err := os.CreateTemp("", "alethia-wif-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}

	if _, err := tmpFile.Write([]byte(wifConfigJSON)); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return nil, fmt.Errorf("failed to write WIF config: %w", err)
	}
	tmpFile.Close()

	os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", tmpFile.Name())
	if projectID != "" {
		os.Setenv("GOOGLE_PROJECT", projectID)
		os.Setenv("GCLOUD_PROJECT", projectID)
		os.Setenv("CLOUDSDK_CORE_PROJECT", projectID)
	}

	cleanup := func() {
		os.Unsetenv("GOOGLE_APPLICATION_CREDENTIALS")
		os.Unsetenv("GOOGLE_PROJECT")
		os.Unsetenv("GCLOUD_PROJECT")
		os.Unsetenv("CLOUDSDK_CORE_PROJECT")
		os.Remove(tmpFile.Name())
	}

	return cleanup, nil
}

// ActivateGcpPlatformSource establishes the AWS source credential a MANAGED runner needs for the GCP WIF
// exchange, KEYLESSLY. The customer's Workload-Identity pool trusts Alethia's platform AWS account, and
// google-auth's `--aws` external-account source signs the WIF subject token with AWS creds read from the
// AWS_* env. A managed Hetzner runner has no ambient AWS identity, so we mint a web-identity assertion from
// the console and exchange it via AssumeRoleWithWebIdentity for temporary platform-account creds, which we
// place in the env. A background refresher re-assumes before the ~1h session expires. No static key anywhere.
// cleanup stops the refresher and unsets the AWS_* vars. (This replaces the retired ECS container-credentials
// path — the managed fleet is Hetzner, not ECS Fargate.)
func ActivateGcpPlatformSource(ctx context.Context, fetcher awsTokenFetcher) (func(), error) {
	if fetcher == nil {
		return nil, fmt.Errorf("no token fetcher for GCP platform source")
	}
	if err := assumePlatformAwsIntoEnv(ctx, fetcher); err != nil {
		return nil, fmt.Errorf("failed to establish GCP AWS source credential: %w", err)
	}

	refreshCtx, cancel := context.WithCancel(ctx)
	go refreshGcpPlatformSource(refreshCtx, fetcher, gcpSourceRefreshInterval)

	cleanup := func() {
		cancel()
		for _, k := range []string{
			"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION",
		} {
			os.Unsetenv(k)
		}
	}
	return cleanup, nil
}

// platformAwsCreds are the temporary AWS credentials the web-identity exchange yields.
type platformAwsCreds struct{ accessKeyID, secretAccessKey, sessionToken string }

// webIdentityAssume exchanges an OIDC token for temporary AWS credentials. A package var so tests can stub
// the STS call; production uses stsAssumeWebIdentity.
var webIdentityAssume = stsAssumeWebIdentity

// assumePlatformAwsIntoEnv mints a web-identity assertion, exchanges it for temporary platform-account AWS
// credentials via AssumeRoleWithWebIdentity, and writes them to the AWS_* env google-auth reads.
func assumePlatformAwsIntoEnv(ctx context.Context, fetcher awsTokenFetcher) error {
	fed, err := fetcher.FetchAwsToken()
	if err != nil {
		return fmt.Errorf("failed to mint AWS federation token: %w", err)
	}
	if fed.PlatformRoleArn == "" {
		return fmt.Errorf("AWS federation response had no platform role ARN")
	}

	region := fed.Region
	if region == "" {
		region = "us-east-1"
	}
	creds, err := webIdentityAssume(ctx, region, fed.PlatformRoleArn, fed.Token)
	if err != nil {
		return fmt.Errorf("AssumeRoleWithWebIdentity failed: %w", err)
	}
	os.Setenv("AWS_ACCESS_KEY_ID", creds.accessKeyID)
	os.Setenv("AWS_SECRET_ACCESS_KEY", creds.secretAccessKey)
	os.Setenv("AWS_SESSION_TOKEN", creds.sessionToken)
	if fed.Region != "" {
		os.Setenv("AWS_REGION", fed.Region)
	}
	return nil
}

// stsAssumeWebIdentity performs the real AssumeRoleWithWebIdentity. The OIDC token authenticates the call,
// so the STS client is anonymous (the managed runner has no ambient AWS identity).
func stsAssumeWebIdentity(ctx context.Context, region, roleArn, token string) (platformAwsCreds, error) {
	stsClient := sts.New(sts.Options{Region: region, Credentials: aws.AnonymousCredentials{}})
	out, err := stsClient.AssumeRoleWithWebIdentity(ctx, &sts.AssumeRoleWithWebIdentityInput{
		RoleArn:          &roleArn,
		WebIdentityToken: &token,
		RoleSessionName:  aws.String("alethia-gcp-source"),
	})
	if err != nil {
		return platformAwsCreds{}, err
	}
	c := out.Credentials
	if c == nil || c.AccessKeyId == nil || c.SecretAccessKey == nil || c.SessionToken == nil {
		return platformAwsCreds{}, fmt.Errorf("AssumeRoleWithWebIdentity returned no credentials")
	}
	return platformAwsCreds{*c.AccessKeyId, *c.SecretAccessKey, *c.SessionToken}, nil
}

// refreshGcpPlatformSource re-assumes the platform AWS source credential every interval until ctx is
// cancelled. A transient failure is left to the next tick — the current env creds stay in place until then.
func refreshGcpPlatformSource(ctx context.Context, fetcher awsTokenFetcher, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = assumePlatformAwsIntoEnv(ctx, fetcher)
		}
	}
}
