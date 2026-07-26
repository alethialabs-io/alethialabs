// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testClientID = "11111111-2222-3333-4444-555555555555"

func TestIsValidUAMIClientID(t *testing.T) {
	if !IsValidUAMIClientID(testClientID) {
		t.Error("valid clientId (GUID) rejected")
	}
	for _, bad := range []string{"", "not-a-guid", testClientID + "; rm -rf /", "1111"} {
		if IsValidUAMIClientID(bad) {
			t.Errorf("malformed clientId %q accepted", bad)
		}
	}
}

func TestNamespaceUAMIName(t *testing.T) {
	a := namespaceUAMIName("cluster-1", "team-web")
	if a != namespaceUAMIName("cluster-1", "team-web") {
		t.Error("not deterministic")
	}
	if a == namespaceUAMIName("cluster-2", "team-web") {
		t.Error("different clusters must differ")
	}
	if len(a) < 3 || len(a) > 128 || !strings.HasPrefix(a, "alethia-ns-") {
		t.Errorf("UAMI name %q not ARM-valid", a)
	}
}

func TestResolveAKSOIDCIssuer(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		mc := `{"properties":{"fqdn":"x","provisioningState":"Succeeded","oidcIssuerProfile":{"enabled":true,"issuerURL":"https://oidc.prod-aks.azure.com/abc/"}}}`
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != aksResourcePath {
				t.Errorf("unexpected path %s", r.URL.Path)
			}
			_, _ = w.Write([]byte(mc))
		}))
		defer srv.Close()
		got, err := ResolveAKSOIDCIssuer(context.Background(), armClientTo(srv), "arm-token", "sub-1", "rg-1", "aks-1")
		if err != nil || got != "https://oidc.prod-aks.azure.com/abc/" {
			t.Fatalf("ResolveAKSOIDCIssuer = (%q, %v)", got, err)
		}
	})
	t.Run("no issuer fails closed", func(t *testing.T) {
		mc := `{"properties":{"provisioningState":"Succeeded","oidcIssuerProfile":{"enabled":false,"issuerURL":""}}}`
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(mc)) }))
		defer srv.Close()
		if _, err := ResolveAKSOIDCIssuer(context.Background(), armClientTo(srv), "arm-token", "sub-1", "rg-1", "aks-1"); err == nil {
			t.Error("empty OIDC issuer = nil error, want a fail-closed error")
		}
	})
}

// msiStub routes the UAMI PUT + the federated-credential PUT, recording the FIC body.
type msiStub struct {
	ficCalled bool
	ficBody   string
}

func (s *msiStub) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer arm-token" {
			t.Errorf("missing/wrong bearer: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/federatedIdentityCredentials/"):
			s.ficCalled = true
			b, _ := io.ReadAll(r.Body)
			s.ficBody = string(b)
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/userAssignedIdentities/"):
			_, _ = w.Write([]byte(`{"properties":{"clientId":"` + testClientID + `"}}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func TestProvisionAKSNamespaceIdentity(t *testing.T) {
	t.Run("create UAMI + federated credential", func(t *testing.T) {
		stub := &msiStub{}
		srv := httptest.NewServer(stub.handler(t))
		defer srv.Close()
		clientID, err := ProvisionAKSNamespaceIdentity(context.Background(), armClientTo(srv), "arm-token",
			"sub-1", "rg-1", "eastus", "https://oidc.example/abc/", "cluster-1", "team-web")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if clientID != testClientID {
			t.Errorf("clientID = %q, want %q", clientID, testClientID)
		}
		if !stub.ficCalled {
			t.Fatal("federated credential was not created")
		}
		for _, want := range []string{"https://oidc.example/abc/", "system:serviceaccount:team-web:default", "api://AzureADTokenExchange"} {
			if !strings.Contains(stub.ficBody, want) {
				t.Errorf("FIC body missing %q: %s", want, stub.ficBody)
			}
		}
	})

	t.Run("empty token fails closed", func(t *testing.T) {
		if _, err := ProvisionAKSNamespaceIdentity(context.Background(), nil, "", "sub-1", "rg-1", "eastus", "iss", "c", "ns"); err == nil {
			t.Error("empty token = nil error, want a fail-closed error")
		}
	})

	t.Run("missing oidc issuer fails closed", func(t *testing.T) {
		if _, err := ProvisionAKSNamespaceIdentity(context.Background(), nil, "arm-token", "sub-1", "rg-1", "eastus", "", "c", "ns"); err == nil {
			t.Error("empty oidcIssuer = nil error, want a fail-closed error")
		}
	})
}
