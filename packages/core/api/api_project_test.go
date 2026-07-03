// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// --- CreateProject ---

func TestCreateProject_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/projects" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["project_name"] != "api" || body["region"] != "eu-west-1" {
			t.Errorf("unexpected body: %+v", body)
		}
		if body["cloud_identity_id"] != "ci1" {
			t.Errorf("expected cloud_identity_id in body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"project": map[string]any{
				"id": "p1", "project_name": "api", "slug": "api", "region": "eu-west-1",
				"iac_version": "1.11.4", "cloud_identity_id": "ci1", "cloud_provider": "aws",
				"environment_stage": "development", "status": "DRAFT",
				"estimated_monthly_cost": nil,
				"created_at":             "2026-01-01T00:00:00.000Z",
				"updated_at":             "2026-01-01T00:00:00.000Z",
			},
		})
	}))
	p, err := client.CreateProject(CreateProjectParams{
		ProjectName: "api", Region: "eu-west-1", CloudIdentityID: "ci1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.ID != "p1" || p.Slug != "api" || p.CloudProvider != "aws" {
		t.Errorf("unexpected project: %+v", p)
	}
}

func TestCreateProject_Error(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "bad"})
	}))
	if _, err := client.CreateProject(CreateProjectParams{ProjectName: "x", Region: "y"}); err == nil {
		t.Fatal("expected error")
	}
}

// --- Environments ---

func TestListEnvironments_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/api/environments" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environments": []map[string]any{
				{"id": "e1", "name": "development", "stage": "development", "status": "DRAFT", "is_default": true, "region": nil},
			},
		})
	}))
	envs, err := client.ListEnvironments("api")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(envs) != 1 || !envs[0].IsDefault || envs[0].Region != nil {
		t.Errorf("unexpected envs: %+v", envs)
	}
}

func TestAddEnvironment_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/projects/api/environments" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "staging" || body["stage"] != "staging" {
			t.Errorf("unexpected body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"environment": map[string]any{
				"id": "e2", "name": "staging", "stage": "staging", "status": "DRAFT",
				"is_default": false, "region": "us-east-1",
			},
		})
	}))
	env, err := client.AddEnvironment("api", "staging", "staging", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env.ID != "e2" || env.Region == nil || *env.Region != "us-east-1" {
		t.Errorf("unexpected env: %+v", env)
	}
}

// --- Components ---

func TestListComponents_Filtered(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/api/components" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("kind") != "databases" {
			t.Errorf("expected kind=databases, got %q", r.URL.Query().Get("kind"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"components": []map[string]any{
				{"id": "c1", "kind": "databases", "name": "main", "status": "PENDING",
					"cloud_identity_id": nil, "config": map[string]any{"engine": "postgres"}},
			},
		})
	}))
	comps, err := client.ListComponents("api", "databases", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(comps) != 1 || comps[0].Config["engine"] != "postgres" || comps[0].CloudIdentityID != nil {
		t.Errorf("unexpected components: %+v", comps)
	}
}

func TestAddComponent_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/projects/api/components/databases" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "main" {
			t.Errorf("unexpected name: %+v", body)
		}
		fields, _ := body["fields"].(map[string]interface{})
		if fields["engine"] != "postgres" {
			t.Errorf("unexpected fields: %+v", fields)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"component": map[string]any{
				"id": "c1", "kind": "databases", "name": "main", "status": "PENDING",
				"cloud_identity_id": nil, "config": map[string]any{},
			},
		})
	}))
	comp, err := client.AddComponent("api", "databases", "main", map[string]interface{}{"engine": "postgres"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if comp.ID != "c1" || comp.Kind != "databases" {
		t.Errorf("unexpected component: %+v", comp)
	}
}

func TestRemoveComponent_Singleton(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		// Singleton: no name segment.
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/projects/api/components/network" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.RemoveComponent("api", "network", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRemoveComponent_Named(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/projects/api/components/databases/main" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.RemoveComponent("api", "databases", "main"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
