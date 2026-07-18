// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
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
)

// dbTokenMinter mints a DB access token + its expiry. Swappable in tests (the real Azure minter
// needs workload-identity env that only exists in-cluster).
type dbTokenMinter func(ctx context.Context) (token string, exp time.Time, err error)

// RunDBToken parses the db-token flags and runs the refresh loop until the context is cancelled.
// Invoked as a one-shot subcommand from main (a sidecar container's entrypoint).
func RunDBToken(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("db-token", flag.ContinueOnError)
	provider := fs.String("provider", "", "cloud provider (azure)")
	out := fs.String("out", "", "path to write the token file (mode 0600)")
	once := fs.Bool("once", false, "write one token and exit (no refresh loop)")
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
	default:
		return fmt.Errorf("db-token: unsupported provider %q (want azure)", *provider)
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
