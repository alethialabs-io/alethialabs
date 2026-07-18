// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	rdsauth "github.com/aws/aws-sdk-go-v2/feature/rds/auth"
)

// db-token is the KEYLESS database-auth refresher sidecar (#722). It runs alongside a workload whose
// bound database uses cloud-native (tokenless) auth, minting a short-lived DB access token from the
// pod's own Workload Identity and writing it to a shared file the local proxy (pgbouncer) reads as
// the upstream credential. Because the token is ~1h-lived but the pod runs for days, it loops and
// re-writes before expiry — the app itself stays password-free and unaware.
//
// Azure: the Entra token for the Postgres AAD resource, via the federated workload identity the AKS
// webhook injects (AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_FEDERATED_TOKEN_FILE) — same mechanism
// as kube-token's mintAzureToken, different scope.

const (
	// pgAADScope is the Entra resource for Azure Database for PostgreSQL Flexible Server AAD login.
	pgAADScope = "https://ossrdbms-aad.database.windows.net/.default"
	// tokenRefreshLead is how far before expiry we re-mint, so a fresh token is always on disk.
	tokenRefreshLead = 5 * time.Minute
	// tokenRefreshFloor bounds the loop so a short/zero TTL can't busy-spin.
	tokenRefreshFloor = 1 * time.Minute
	// awsRDSTokenTTL is how long an RDS IAM auth token is valid (AWS fixes this at 15 minutes); the
	// SDK doesn't return the expiry, so we derive it.
	awsRDSTokenTTL = 15 * time.Minute
)

// dbTokenMinter mints a DB access token + its expiry. Swappable in tests (the real Azure minter
// needs workload-identity env that only exists in-cluster).
type dbTokenMinter func(ctx context.Context) (token string, exp time.Time, err error)

// RunDBToken parses the db-token flags and runs the refresh loop until the context is cancelled.
// Invoked as a one-shot subcommand from main (a sidecar container's entrypoint).
func RunDBToken(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("db-token", flag.ContinueOnError)
	provider := fs.String("provider", "", "cloud provider (aws|azure)")
	out := fs.String("out", "", "path to write the token file (mode 0600)")
	once := fs.Bool("once", false, "write one token and exit (no refresh loop)")
	host := fs.String("host", "", "database host (AWS RDS: the endpoint the token is signed for)")
	port := fs.String("port", "5432", "database port (AWS)")
	region := fs.String("region", "", "cloud region (AWS)")
	user := fs.String("user", "", "database user the token authenticates as (AWS)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *out == "" {
		return fmt.Errorf("db-token: --out is required")
	}
	var mint dbTokenMinter
	switch *provider {
	case "azure":
		mint = mintAzureDBToken
	case "aws":
		if *host == "" || *region == "" || *user == "" {
			return fmt.Errorf("db-token aws: --host, --region and --user are required")
		}
		endpoint := net.JoinHostPort(*host, *port)
		mint = func(ctx context.Context) (string, time.Time, error) {
			return mintAWSDBToken(ctx, endpoint, *region, *user)
		}
	default:
		return fmt.Errorf("db-token: unsupported provider %q (want aws|azure)", *provider)
	}
	return runDBTokenLoop(ctx, mint, *out, *once)
}

// runDBTokenLoop mints a token, writes it, then sleeps until just before expiry and repeats. The
// FIRST mint failing is fatal (fail fast — the pod is misconfigured); a later refresh failure is
// retried on the floor interval so a transient blip doesn't tear down a working workload.
func runDBTokenLoop(ctx context.Context, mint dbTokenMinter, out string, once bool) error {
	token, exp, err := mint(ctx)
	if err != nil {
		return fmt.Errorf("db-token: initial mint: %w", err)
	}
	if err := writeTokenFile(out, token); err != nil {
		return fmt.Errorf("db-token: write %s: %w", out, err)
	}
	if once {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(refreshAfter(exp, time.Now())):
		}
		token, exp, err = mint(ctx)
		if err != nil {
			// Keep the last good token on disk; retry on the floor interval.
			fmt.Fprintf(os.Stderr, "db-token: refresh failed (keeping last token): %v\n", err)
			exp = time.Now().Add(tokenRefreshFloor + tokenRefreshLead)
			continue
		}
		if err := writeTokenFile(out, token); err != nil {
			return fmt.Errorf("db-token: write %s: %w", out, err)
		}
	}
}

// refreshAfter is how long to wait before re-minting: tokenRefreshLead before expiry, floored so a
// near-immediate expiry can't busy-loop.
func refreshAfter(exp, now time.Time) time.Duration {
	d := exp.Sub(now) - tokenRefreshLead
	if d < tokenRefreshFloor {
		return tokenRefreshFloor
	}
	return d
}

// writeTokenFile writes the token to path atomically at mode 0600 (a temp file in the same dir +
// rename), so a reader never sees a half-written token and the token is never world-readable.
func writeTokenFile(path, token string) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".dbtoken-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(token); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// mintAWSDBToken mints an RDS IAM auth token for `user` at `endpoint` (host:port) — a presigned STS
// request the RDS engine accepts as the password, generated in-process from the pod's IRSA role (no
// stored secret). AWS fixes the validity at 15 minutes; the SDK doesn't return the expiry, so we
// derive it from awsRDSTokenTTL.
func mintAWSDBToken(ctx context.Context, endpoint, region, user string) (string, time.Time, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("load AWS config: %w", err)
	}
	tok, err := rdsauth.BuildAuthToken(ctx, endpoint, region, user, cfg.Credentials)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("build RDS auth token: %w", err)
	}
	return tok, time.Now().Add(awsRDSTokenTTL), nil
}

// mintAzureDBToken mints an Entra access token for Azure Postgres via the pod's federated workload
// identity — the same NewWorkloadIdentityCredential path as kube-token's mintAzureToken, with the
// Postgres AAD scope instead of the AKS one.
func mintAzureDBToken(ctx context.Context) (string, time.Time, error) {
	cred, err := azidentity.NewWorkloadIdentityCredential(nil)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("azure workload identity credential: %w", err)
	}
	tok, err := cred.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{pgAADScope}})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("obtain Postgres AAD token: %w", err)
	}
	return tok.Token, tok.ExpiresOn, nil
}
