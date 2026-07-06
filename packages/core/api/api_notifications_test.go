// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// --- Channels ---

func TestListChannels_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/channels" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"channels": []map[string]any{
				{
					"id": "c1", "type": "slack", "name": "ops", "enabled": true,
					"is_verified": true, "recipients": []string{}, "has_secret": true,
					"last_verified_at": nil, "created_at": "2026-01-01T00:00:00.000Z",
				},
			},
		})
	}))
	channels, err := client.ListChannels()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(channels) != 1 || channels[0].Name != "ops" || !channels[0].HasSecret {
		t.Errorf("unexpected channels: %+v", channels)
	}
}

func TestCreateChannel_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/channels" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "ops" || body["type"] != "slack" {
			t.Errorf("unexpected body: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"channel": map[string]any{
				"id": "c2", "type": "slack", "name": "ops", "enabled": true,
				"is_verified": true, "recipients": []string{}, "has_secret": true,
				"last_verified_at": "2026-01-01T00:00:00.000Z", "created_at": "2026-01-01T00:00:00.000Z",
			},
		})
	}))
	ch, err := client.CreateChannel("ops", "slack", map[string]interface{}{"url": "https://hooks.example.com"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ch.ID != "c2" || !ch.IsVerified {
		t.Errorf("unexpected channel: %+v", ch)
	}
}

func TestVerifyChannel_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/channels/c1/verify" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"channel": map[string]any{
				"id": "c1", "type": "slack", "name": "ops", "enabled": true,
				"is_verified": true, "recipients": []string{}, "has_secret": true,
				"last_verified_at": "2026-01-01T00:00:00.000Z", "created_at": "2026-01-01T00:00:00.000Z",
			},
		})
	}))
	ch, err := client.VerifyChannel("c1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ch.IsVerified {
		t.Errorf("expected verified channel: %+v", ch)
	}
}

func TestDeleteChannel_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/channels/c9" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.DeleteChannel("c9"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Alert rules ---

func TestListAlertRules_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/alerts" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"alert_rules": []map[string]any{
				{
					"id": "a1", "name": "failures", "description": nil,
					"event_patterns": []string{"system.job.failed"}, "severity": "critical",
					"throttle_seconds": 0, "enabled": true, "channel_ids": []string{"c1"},
					"created_at": "2026-01-01T00:00:00.000Z",
				},
			},
		})
	}))
	rules, err := client.ListAlertRules()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rules) != 1 || rules[0].Name != "failures" || len(rules[0].ChannelIDs) != 1 {
		t.Errorf("unexpected rules: %+v", rules)
	}
}

func TestCreateAlertRule_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/alerts" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "failures" || body["severity"] != "critical" {
			t.Errorf("unexpected body: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"alert_rule": map[string]any{
				"id": "a2", "name": "failures", "description": nil,
				"event_patterns": []string{"system.job.failed"}, "severity": "critical",
				"throttle_seconds": 0, "enabled": true, "channel_ids": []string{"c1"},
				"created_at": "2026-01-01T00:00:00.000Z",
			},
		})
	}))
	rule, err := client.CreateAlertRule("failures", []string{"system.job.failed"}, []string{"c1"}, "critical")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rule.ID != "a2" || rule.Severity != "critical" {
		t.Errorf("unexpected rule: %+v", rule)
	}
}

func TestDeleteAlertRule_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/alerts/a9" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.DeleteAlertRule("a9"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Activity ---

func TestListActivity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/activity" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "10" {
			t.Errorf("expected limit=10, got %q", got)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"activity": []map[string]any{
				{
					"id": "42", "actor_id": "u1", "actor_name": "Ada", "actor_email": "ada@x.com",
					"action": "deploy", "resource_type": "project", "resource_id": nil,
					"decision": true, "reason": nil, "ts": "2026-01-01T00:00:00.000Z",
				},
			},
		})
	}))
	entries, err := client.ListActivity(10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "deploy" || !entries[0].Decision {
		t.Errorf("unexpected activity: %+v", entries)
	}
}
