// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func dbBinding() types.ServiceBinding {
	return types.ServiceBinding{
		Target: types.ServiceBindingTarget{Kind: "database", Name: "main"},
		Inject: []types.ServiceBindingInjection{
			{Env: "DB_HOST", From: "endpoint"}, // non-secret → NOT in the ExternalSecret
			{Env: "DB_PORT", From: "port"},     // non-secret
			{Env: "DB_USER", From: "username"}, // credential
			{Env: "DB_PASS", From: "password"}, // credential
		},
	}
}

func TestRenderExternalSecret_AWS(t *testing.T) {
	y, skipped, err := RenderExternalSecret(ExternalSecretParams{
		Namespace: "demo",
		Target:    types.ServiceBindingTarget{Kind: "database", Name: "main"},
		Provider:  "aws",
		RemoteKey: "rds-euc1-prod-acme",
		Facets:    CredentialFacetNames(dbBinding()),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(skipped) != 0 {
		t.Errorf("nothing should be skipped for aws username/password, got %v", skipped)
	}
	for _, want := range []string{
		"apiVersion: external-secrets.io/v1beta1", // MUST match the deployed ESO 0.9.12
		"kind: ExternalSecret",
		"name: alethia-bind-database-main", // BindingSecretName(kind, name) — shared with the render lane
		"namespace: demo",
		"name: secretstore-aws",
		"kind: ClusterSecretStore",
		"creationPolicy: Owner",
		"secretKey: username",
		"secretKey: password",
		"key: rds-euc1-prod-acme",
		"property: username",
		"property: password",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("ExternalSecret missing %q:\n%s", want, y)
		}
	}
	// Non-secret facets (endpoint/port) must NOT appear — those are the render-bindings lane's job.
	if strings.Contains(y, "endpoint") || strings.Contains(y, "DB_HOST") || strings.Contains(y, "DB_PORT") {
		t.Errorf("non-secret facets must not be materialized:\n%s", y)
	}
}

func TestStoreNameFor(t *testing.T) {
	cases := map[string]string{
		"aws":     "secretstore-aws",
		"gcp":     "secretstore-gcp",
		"azure":   "secretstore-azure",
		"alibaba": "secretstore-alibaba",
		"hetzner": "", // no ESO store → credential facets unsatisfiable
		"":        "",
	}
	for provider, want := range cases {
		if got := StoreNameFor(provider); got != want {
			t.Errorf("StoreNameFor(%q) = %q, want %q", provider, got, want)
		}
	}
}

func TestCredentialFacetNames(t *testing.T) {
	got := CredentialFacetNames(dbBinding())
	// Only credential facets, deduped + sorted; endpoint/port excluded.
	if len(got) != 2 || got[0] != "password" || got[1] != "username" {
		t.Errorf("CredentialFacetNames = %v, want [password username]", got)
	}
	// A binding with only non-secret facets needs no ExternalSecret.
	noCreds := types.ServiceBinding{Inject: []types.ServiceBindingInjection{{Env: "H", From: "endpoint"}}}
	if len(CredentialFacetNames(noCreds)) != 0 {
		t.Error("endpoint-only binding should have no credential facets")
	}
}

func TestIsCredentialFacet(t *testing.T) {
	for _, f := range []string{"username", "password", "connection_string"} {
		if !IsCredentialFacet(f) {
			t.Errorf("%q should be a credential facet", f)
		}
	}
	for _, f := range []string{"endpoint", "port", ""} {
		if IsCredentialFacet(f) {
			t.Errorf("%q should NOT be a credential facet", f)
		}
	}
}

func TestRenderExternalSecret_NoStore(t *testing.T) {
	y, skipped, err := RenderExternalSecret(ExternalSecretParams{
		Target:    types.ServiceBindingTarget{Kind: "database", Name: "main"},
		Provider:  "hetzner", // no ClusterSecretStore
		RemoteKey: "whatever",
		Facets:    []string{"username", "password"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if y != "" || len(skipped) != 1 {
		t.Errorf("hetzner should render nothing and report 1 skip; y=%q skipped=%v", y, skipped)
	}
}

func TestRenderExternalSecret_NoRemoteKey(t *testing.T) {
	_, skipped, err := RenderExternalSecret(ExternalSecretParams{
		Target:    types.ServiceBindingTarget{Kind: "cache", Name: "redis"},
		Provider:  "aws",
		RemoteKey: "", // e.g. AWS Elasticache has no master-credentials secret
		Facets:    []string{"password"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(skipped) != 1 {
		t.Errorf("missing remote secret should report 1 skip, got %v", skipped)
	}
}

func TestRenderExternalSecret_UnsatisfiableFacet(t *testing.T) {
	// connection_string is a credential facet but has no property in the AWS master secret.
	y, skipped, err := RenderExternalSecret(ExternalSecretParams{
		Target:    types.ServiceBindingTarget{Kind: "database", Name: "main"},
		Provider:  "aws",
		RemoteKey: "rds-x",
		Facets:    []string{"password", "connection_string"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// password renders; connection_string is skipped + reported.
	if !strings.Contains(y, "secretKey: password") {
		t.Errorf("password should still render:\n%s", y)
	}
	if strings.Contains(y, "connection_string") {
		t.Errorf("connection_string has no AWS property and must not render:\n%s", y)
	}
	if len(skipped) != 1 || !strings.Contains(skipped[0], "connection_string") {
		t.Errorf("connection_string should be reported skipped, got %v", skipped)
	}
}
