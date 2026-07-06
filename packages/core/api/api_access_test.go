// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// --- Roles ---

func TestListRoles_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/roles" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"roles": []map[string]any{
				{
					"id": "r1", "name": "owner", "description": "Full control.",
					"is_builtin": true, "permission_keys": []string{"org:view", "org:edit"},
				},
				{
					"id": "r2", "name": "deployers", "description": nil,
					"is_builtin": false, "permission_keys": []string{"project:deploy"},
				},
			},
		})
	}))
	roles, err := client.ListRoles()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roles) != 2 || roles[0].Name != "owner" || !roles[0].IsBuiltin {
		t.Errorf("unexpected roles: %+v", roles)
	}
	if len(roles[1].PermissionKeys) != 1 || roles[1].PermissionKeys[0] != "project:deploy" {
		t.Errorf("unexpected custom role: %+v", roles[1])
	}
}

func TestCreateRole_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/roles" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "deployers" {
			t.Errorf("unexpected body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"role": map[string]any{
				"id": "r9", "name": "deployers", "description": nil,
				"is_builtin": false, "permission_keys": []string{"project:deploy"},
			},
		})
	}))
	role, err := client.CreateRole("deployers", []string{"project:deploy"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if role.ID != "r9" || role.IsBuiltin {
		t.Errorf("unexpected role: %+v", role)
	}
}

func TestDeleteRole_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/roles/r9" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.DeleteRole("r9"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Grants ---

func TestListGrants_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/grants" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"grants": []map[string]any{
				{
					"id": "g1", "principal_type": "user", "principal_id": "u1",
					"effect": "allow", "role": "deployers", "permission_key": nil,
					"resource_type": "project", "resource_id": "p1",
				},
			},
		})
	}))
	grants, err := client.ListGrants()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(grants) != 1 || grants[0].Role != "deployers" || grants[0].ResourceType != "project" {
		t.Errorf("unexpected grants: %+v", grants)
	}
}

func TestAddGrant_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/grants" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["principal_id"] != "u1" || body["permission_key"] != "project:deploy" {
			t.Errorf("unexpected body: %+v", body)
		}
		if _, ok := body["role_id"]; ok {
			t.Error("role_id should be omitted when empty")
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"grant": map[string]any{
				"id": "g9", "principal_type": "user", "principal_id": "u1",
				"effect": "allow", "role": nil, "permission_key": "project:deploy",
				"resource_type": "org", "resource_id": nil,
			},
		})
	}))
	grant, err := client.AddGrant(AddGrantParams{
		PrincipalType: "user",
		PrincipalID:   "u1",
		PermissionKey: "project:deploy",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grant.ID != "g9" || grant.PermissionKey != "project:deploy" {
		t.Errorf("unexpected grant: %+v", grant)
	}
}

func TestRemoveGrant_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/grants/g9" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.RemoveGrant("g9"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- SSO ---

func TestListSsoProviders_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/sso" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"sso_providers": []map[string]any{
				{
					"id": "s1", "provider_type": "oidc", "domain": "acme.com",
					"issuer": "https://idp.acme.com", "enabled": true,
				},
			},
		})
	}))
	providers, err := client.ListSsoProviders()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(providers) != 1 || providers[0].ProviderType != "oidc" || !providers[0].Enabled {
		t.Errorf("unexpected providers: %+v", providers)
	}
}

func TestGetSsoProvider_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/sso/s1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"sso_provider": map[string]any{
				"id": "s1", "provider_type": "saml", "domain": "acme.com",
				"issuer": "https://idp.acme.com", "enabled": false,
			},
		})
	}))
	provider, err := client.GetSsoProvider("s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider.ID != "s1" || provider.ProviderType != "saml" || provider.Enabled {
		t.Errorf("unexpected provider: %+v", provider)
	}
}

func TestGetSsoProvider_NotFound(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "SSO provider not found"})
	}))
	if _, err := client.GetSsoProvider("bad"); err == nil {
		t.Fatal("expected error for 404")
	}
}
