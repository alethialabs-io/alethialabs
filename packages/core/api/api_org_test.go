// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// --- Whoami ---

func TestWhoami_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/whoami" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"user":           map[string]any{"id": "u1", "email": "ada@example.com", "name": "Ada"},
			"active_org":     map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
			"default_runner": map[string]any{"id": "r1", "name": "primary"},
		})
	}))

	me, err := client.Whoami()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if me.User.Email != "ada@example.com" {
		t.Errorf("unexpected user: %+v", me.User)
	}
	if me.ActiveOrg == nil || me.ActiveOrg.Plan != "team" {
		t.Errorf("unexpected active org: %+v", me.ActiveOrg)
	}
	if me.DefaultRunner == nil || me.DefaultRunner.Name != "primary" {
		t.Errorf("unexpected default runner: %+v", me.DefaultRunner)
	}
}

func TestWhoami_ServerError(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "bad token"})
	}))
	if _, err := client.Whoami(); err == nil {
		t.Fatal("expected error")
	}
}

// --- ListOrgs ---

func TestListOrgs_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/orgs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"orgs": []map[string]any{
				{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
			},
		})
	}))
	orgs, err := client.ListOrgs()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(orgs) != 1 || orgs[0].Slug != "acme" {
		t.Errorf("unexpected orgs: %+v", orgs)
	}
}

// --- Members ---

func TestListMembers_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/orgs/o1/members" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"members": []map[string]any{
				{"id": "m1", "user_id": "u1", "email": "a@x.com", "name": "A", "role": "owner", "status": "active"},
			},
		})
	}))
	members, err := client.ListMembers("o1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(members) != 1 || members[0].Email != "a@x.com" {
		t.Errorf("unexpected members: %+v", members)
	}
}

func TestInviteMember_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/orgs/o1/members" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["email"] != "new@x.com" || body["role"] != "member" {
			t.Errorf("unexpected body: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"invitation": map[string]any{"id": "inv1", "email": "new@x.com", "role": "member", "status": "pending"},
		})
	}))
	inv, err := client.InviteMember("o1", "new@x.com", "member")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if inv.ID != "inv1" || inv.Status != "pending" {
		t.Errorf("unexpected invitation: %+v", inv)
	}
}

func TestRemoveMember_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/orgs/o1/members/m9" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.RemoveMember("o1", "m9"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Teams ---

func TestListTeams_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/orgs/o1/teams" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"teams": []map[string]any{{"id": "t1", "name": "Platform", "member_count": 3}},
		})
	}))
	teams, err := client.ListTeams("o1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(teams) != 1 || teams[0].MemberCount != 3 {
		t.Errorf("unexpected teams: %+v", teams)
	}
}

func TestCreateTeam_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/orgs/o1/teams" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "SRE" {
			t.Errorf("unexpected body: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"team": map[string]any{"id": "t2", "name": "SRE", "member_count": 0},
		})
	}))
	team, err := client.CreateTeam("o1", "SRE")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if team.ID != "t2" || team.Name != "SRE" {
		t.Errorf("unexpected team: %+v", team)
	}
}

func TestDeleteTeam_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/orgs/o1/teams/t9" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.DeleteTeam("o1", "t9"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- X-Alethia-Org header ---

func TestActiveOrgHeader_SentWhenConfigured(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "org-xyz"}); err != nil {
		t.Fatalf("save config: %v", err)
	}

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Alethia-Org"); got != "org-xyz" {
			t.Errorf("expected X-Alethia-Org org-xyz, got %q", got)
		}
		json.NewEncoder(w).Encode(map[string]any{"orgs": []any{}})
	}))
	if _, err := client.ListOrgs(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestActiveOrgHeader_AbsentWhenUnset(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Alethia-Org"); got != "" {
			t.Errorf("expected no X-Alethia-Org header, got %q", got)
		}
		json.NewEncoder(w).Encode(map[string]any{"orgs": []any{}})
	}))
	if _, err := client.ListOrgs(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
