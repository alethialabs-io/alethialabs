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

// azureTokenFetcher mints a keyless Azure federation assertion. Satisfied by *RunnerAPIClient
// (FetchAzureToken); an interface so the activation is unit-testable with a stub.
type azureTokenFetcher interface {
	FetchAzureToken(jobID string) (string, error)
}

// azureRefreshInterval is how often the background refresher re-mints the assertion into the token file.
// The minted assertion lives ≤10 min (issuer MAX_TTL_SECONDS = 600); refreshing every 5 min guarantees the
// file always holds an assertion with ≥5 min of validity whenever azurerm re-reads it to re-exchange for a
// fresh ~1h ARM token — so an apply longer than the ARM token lifetime keeps authenticating.
const azureRefreshInterval = 5 * time.Minute

// ActivateAzureFederated authenticates the runner to Azure KEYLESSLY for a `tofu apply`. It fetches a
// short-lived OIDC assertion from the console (minted by the Alethia issuer; the customer's user-assigned
// managed identity's federated credential trusts it), exchanged AS that customer identity (clientID).
// It writes the assertion to a temp file and points OpenTofu's azurerm/azuread providers at that FILE
// (ARM_OIDC_TOKEN_FILE_PATH) plus the Azure SDK / kubelogin path (AZURE_FEDERATED_TOKEN_FILE).
//
// Crucially it does NOT set the literal ARM_OIDC_TOKEN: azurerm prefers the literal when present and would
// then never re-read the file, so a >1h apply (or a provider re-init past the 10-min assertion) would fail
// on a dead token. By using the file + a background refresher that re-mints into it every few minutes,
// azurerm always re-reads a live assertion. No client secret is ever present on the runner. cleanup stops
// the refresher, unsets the vars, and removes the temp file.
func ActivateAzureFederated(ctx context.Context, fetcher azureTokenFetcher, tenantID, clientID, subscriptionID, jobID string) (func(), error) {
	if tenantID == "" || clientID == "" {
		return nil, fmt.Errorf("missing Azure tenant_id or client_id")
	}
	if fetcher == nil {
		return nil, fmt.Errorf("no token fetcher for Azure federation")
	}

	token, err := fetcher.FetchAzureToken(jobID)
	if err != nil {
		return nil, fmt.Errorf("failed to mint Azure federation token: %w", err)
	}

	// Write the assertion into a per-job DIRECTORY (not a bare /tmp file) so the container
	// sandbox can RO-bind-mount the directory and see the atomic-rename refresh (a per-file
	// bind mount would pin the stale inode and auth would die mid-apply).
	tokenDir, err := os.MkdirTemp("", "alethia-azure-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create Azure cred dir: %w", err)
	}
	tokenPath := filepath.Join(tokenDir, "oidc-token")
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		os.RemoveAll(tokenDir)
		return nil, fmt.Errorf("failed to write Azure token file: %w", err)
	}

	// azurerm / azuread (OpenTofu) read ARM_*; the Azure SDK + kubelogin read the AZURE_* ones. We set the
	// FILE path, not the literal ARM_OIDC_TOKEN, so the providers re-read the (refreshed) assertion.
	os.Setenv("ARM_USE_OIDC", "true")
	os.Setenv("ARM_CLIENT_ID", clientID)
	os.Setenv("ARM_TENANT_ID", tenantID)
	os.Setenv("ARM_SUBSCRIPTION_ID", subscriptionID)
	os.Setenv("ARM_OIDC_TOKEN_FILE_PATH", tokenPath)
	os.Setenv("AZURE_CLIENT_ID", clientID)
	os.Setenv("AZURE_TENANT_ID", tenantID)
	os.Setenv("AZURE_SUBSCRIPTION_ID", subscriptionID)
	os.Setenv("AZURE_FEDERATED_TOKEN_FILE", tokenPath)

	// Keep the assertion fresh for the life of the job so long applies survive past the 10-min TTL.
	refreshCtx, cancel := context.WithCancel(ctx)
	go refreshAzureToken(refreshCtx, fetcher, tokenPath, azureRefreshInterval, jobID)

	cleanup := func() {
		cancel()
		for _, k := range []string{
			"ARM_USE_OIDC", "ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID",
			"ARM_OIDC_TOKEN", "ARM_OIDC_TOKEN_FILE_PATH",
			"AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_FEDERATED_TOKEN_FILE",
		} {
			os.Unsetenv(k)
		}
		os.RemoveAll(filepath.Dir(tokenPath))
	}

	return cleanup, nil
}

// refreshAzureToken re-mints the OIDC assertion into tokenPath every azureRefreshInterval until ctx is
// cancelled. A transient mint failure is left to the next tick — the existing file stays valid until then,
// and azurerm only re-reads it roughly hourly — so we never clobber a good token with an error.
func refreshAzureToken(ctx context.Context, fetcher azureTokenFetcher, tokenPath string, interval time.Duration, jobID string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			token, err := fetcher.FetchAzureToken(jobID)
			if err != nil || token == "" {
				continue
			}
			_ = writeTokenFileAtomic(tokenPath, token)
		}
	}
}

// writeTokenFileAtomic replaces tokenPath's contents in one step (write a sibling temp, then rename) so a
// concurrent provider read never sees a half-written assertion.
func writeTokenFileAtomic(tokenPath, token string) error {
	dir := filepath.Dir(tokenPath)
	tmp, err := os.CreateTemp(dir, ".alethia-azure-oidc-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(token); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, tokenPath); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}
