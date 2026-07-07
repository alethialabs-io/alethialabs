// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"os"
)

// azureTokenFetcher mints a keyless Azure federation assertion. Satisfied by *RunnerAPIClient
// (FetchAzureToken); an interface so the activation is unit-testable with a stub.
type azureTokenFetcher interface {
	FetchAzureToken() (string, error)
}

// ActivateAzureFederated authenticates the runner to Azure KEYLESSLY for a `tofu apply`. It fetches
// a short-lived OIDC assertion from the console (minted by the Alethia issuer for the platform Entra
// app), writes it to a temp file, and sets the env OpenTofu's azurerm/azuread providers read:
// ARM_USE_OIDC + ARM_OIDC_TOKEN (direct) and AZURE_FEDERATED_TOKEN_FILE (for the Azure SDK / kubelogin
// path). The azurerm provider exchanges the ≤10-min assertion for a ~1h ARM access token at init, so a
// long apply rides that token — the short TTL only needs to cover apply start. No client secret is
// ever present on the runner. cleanup unsets the vars and removes the temp file.
func ActivateAzureFederated(fetcher azureTokenFetcher, tenantID, clientID, subscriptionID string) (func(), error) {
	if tenantID == "" || clientID == "" {
		return nil, fmt.Errorf("missing Azure tenant_id or client_id")
	}
	if fetcher == nil {
		return nil, fmt.Errorf("no token fetcher for Azure federation")
	}

	token, err := fetcher.FetchAzureToken()
	if err != nil {
		return nil, fmt.Errorf("failed to mint Azure federation token: %w", err)
	}

	tokenFile, err := os.CreateTemp("", "alethia-azure-oidc-*.jwt")
	if err != nil {
		return nil, fmt.Errorf("failed to create Azure token file: %w", err)
	}
	tokenPath := tokenFile.Name()
	if _, err := tokenFile.WriteString(token); err != nil {
		tokenFile.Close()
		os.Remove(tokenPath)
		return nil, fmt.Errorf("failed to write Azure token file: %w", err)
	}
	tokenFile.Close()

	// azurerm / azuread (OpenTofu) read the ARM_* vars; the Azure SDK + kubelogin read the AZURE_* ones.
	os.Setenv("ARM_USE_OIDC", "true")
	os.Setenv("ARM_CLIENT_ID", clientID)
	os.Setenv("ARM_TENANT_ID", tenantID)
	os.Setenv("ARM_SUBSCRIPTION_ID", subscriptionID)
	os.Setenv("ARM_OIDC_TOKEN", token)
	os.Setenv("ARM_OIDC_TOKEN_FILE_PATH", tokenPath)
	os.Setenv("AZURE_CLIENT_ID", clientID)
	os.Setenv("AZURE_TENANT_ID", tenantID)
	os.Setenv("AZURE_SUBSCRIPTION_ID", subscriptionID)
	os.Setenv("AZURE_FEDERATED_TOKEN_FILE", tokenPath)

	cleanup := func() {
		for _, k := range []string{
			"ARM_USE_OIDC", "ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID",
			"ARM_OIDC_TOKEN", "ARM_OIDC_TOKEN_FILE_PATH",
			"AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_FEDERATED_TOKEN_FILE",
		} {
			os.Unsetenv(k)
		}
		os.Remove(tokenPath)
	}

	return cleanup, nil
}
