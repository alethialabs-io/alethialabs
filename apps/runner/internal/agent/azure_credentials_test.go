// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"os"
	"testing"
)

type stubAzureFetcher struct {
	token string
	err   error
	calls int
}

func (s *stubAzureFetcher) FetchAzureToken() (string, error) {
	s.calls++
	return s.token, s.err
}

func TestActivateAzureFederated_SetsEnvAndCleansUp(t *testing.T) {
	fetcher := &stubAzureFetcher{token: "minted.jwt.token"}
	cleanup, err := ActivateAzureFederated(fetcher, "tenant-1", "client-1", "sub-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fetcher.calls != 1 {
		t.Errorf("expected the token to be fetched once, got %d", fetcher.calls)
	}

	// azurerm (OpenTofu) reads these; the direct token drives the keyless exchange.
	if os.Getenv("ARM_USE_OIDC") != "true" {
		t.Error("ARM_USE_OIDC should be true")
	}
	if os.Getenv("ARM_OIDC_TOKEN") != "minted.jwt.token" {
		t.Error("ARM_OIDC_TOKEN should be the minted token")
	}
	if os.Getenv("ARM_CLIENT_ID") != "client-1" || os.Getenv("ARM_TENANT_ID") != "tenant-1" ||
		os.Getenv("ARM_SUBSCRIPTION_ID") != "sub-1" {
		t.Error("ARM_* identity vars should be set from the identity")
	}

	tokenPath := os.Getenv("AZURE_FEDERATED_TOKEN_FILE")
	if tokenPath == "" {
		t.Fatal("AZURE_FEDERATED_TOKEN_FILE should point at the token file")
	}
	data, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("token file should exist: %v", err)
	}
	if string(data) != "minted.jwt.token" {
		t.Errorf("token file content = %q, want the minted token", string(data))
	}

	cleanup()

	for _, k := range []string{"ARM_USE_OIDC", "ARM_OIDC_TOKEN", "ARM_CLIENT_ID", "AZURE_FEDERATED_TOKEN_FILE"} {
		if os.Getenv(k) != "" {
			t.Errorf("%s should be cleared after cleanup", k)
		}
	}
	if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
		t.Error("token file should be removed after cleanup")
	}
}

func TestActivateAzureFederated_FetchError(t *testing.T) {
	fetcher := &stubAzureFetcher{err: fmt.Errorf("issuer down")}
	if _, err := ActivateAzureFederated(fetcher, "tenant-1", "client-1", "sub-1"); err == nil {
		t.Error("expected an error when the token mint fails")
	}
}

func TestActivateAzureFederated_MissingIdentity(t *testing.T) {
	fetcher := &stubAzureFetcher{token: "x"}
	if _, err := ActivateAzureFederated(fetcher, "", "client-1", "sub-1"); err == nil {
		t.Error("expected an error when tenant_id is missing")
	}
	if fetcher.calls != 0 {
		t.Error("should not fetch a token when the identity is incomplete")
	}
}
