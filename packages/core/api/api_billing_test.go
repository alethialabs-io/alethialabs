// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// --- Billing ---

func TestGetBilling_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/billing" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"billing": map[string]any{
				"plan": "team", "status": "active", "seats": 5,
				"stripe_subscription_id": "sub_123", "trial_ends_at": nil,
				"current_period_end": "2026-02-01T00:00:00.000Z",
			},
		})
	}))
	billing, err := client.GetBilling()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if billing.Plan != "team" || billing.Status != "active" {
		t.Errorf("unexpected billing: %+v", billing)
	}
	if billing.Seats == nil || *billing.Seats != 5 {
		t.Errorf("expected 5 seats, got %+v", billing.Seats)
	}
	if billing.StripeSubscriptionID != "sub_123" {
		t.Errorf("unexpected subscription id: %s", billing.StripeSubscriptionID)
	}
}

func TestGetBilling_NullSeats(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"billing": map[string]any{
				"plan": "community", "status": "none", "seats": nil,
				"stripe_subscription_id": nil, "trial_ends_at": nil, "current_period_end": nil,
			},
		})
	}))
	billing, err := client.GetBilling()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if billing.Seats != nil {
		t.Errorf("expected nil seats, got %+v", billing.Seats)
	}
}

func TestGetBilling_ServerError(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "db down"})
	}))
	if _, err := client.GetBilling(); err == nil {
		t.Fatal("expected error for 500 response")
	}
}

// --- Usage ---

func TestGetUsage_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/usage" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"usage": map[string]any{
				"seats_used": 3, "seats_cap": 5, "runner_minutes": 120,
				"projects": 7, "ai_credits_used": 450, "ai_credits_granted": 3000,
			},
		})
	}))
	usage, err := client.GetUsage()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if usage.SeatsUsed != 3 || usage.SeatsCap != 5 || usage.RunnerMinutes != 120 {
		t.Errorf("unexpected usage: %+v", usage)
	}
	if usage.Projects != 7 || usage.AICreditsUsed != 450 || usage.AICreditsGranted != 3000 {
		t.Errorf("unexpected usage: %+v", usage)
	}
}

// --- Fleet pools ---

func TestListFleetPools_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/fleet" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"pools": []map[string]any{
				{
					"provider": "aws", "warm_min": 1, "max": 10, "slots_per_runner": 2,
					"locations": []string{"fsn1", "nbg1"}, "surge": 1, "buffer": 1,
					"channel": "stable", "version": nil, "enabled": true,
				},
			},
		})
	}))
	pools, err := client.ListFleetPools()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pools) != 1 || pools[0].Provider != "aws" || pools[0].WarmMin != 1 {
		t.Errorf("unexpected pools: %+v", pools)
	}
	if len(pools[0].Locations) != 2 || pools[0].Channel != "stable" {
		t.Errorf("unexpected pool config: %+v", pools[0])
	}
}

func TestSetFleetPool_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "PUT" || r.URL.Path != "/api/cli/fleet/aws" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["warm_min"] != float64(3) {
			t.Errorf("expected warm_min=3, got %v", body["warm_min"])
		}
		if _, ok := body["max"]; ok {
			t.Error("max should be omitted when not set")
		}
		if body["enabled"] != false {
			t.Errorf("expected enabled=false, got %v", body["enabled"])
		}
		json.NewEncoder(w).Encode(map[string]any{
			"pool": map[string]any{
				"provider": "aws", "warm_min": 3, "max": 10, "slots_per_runner": 1,
				"locations": []string{"fsn1"}, "surge": 1, "buffer": 1,
				"channel": nil, "version": "v1.2.3", "enabled": false,
			},
		})
	}))
	warmMin := 3
	enabled := false
	version := "v1.2.3"
	pool, err := client.SetFleetPool("aws", FleetPoolUpdate{
		WarmMin: &warmMin, Enabled: &enabled, Version: &version,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pool.WarmMin != 3 || pool.Enabled || pool.Version != "v1.2.3" {
		t.Errorf("unexpected pool: %+v", pool)
	}
}

func TestSetFleetPool_Forbidden(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "The managed fleet is not available on this deployment."})
	}))
	if _, err := client.SetFleetPool("aws", FleetPoolUpdate{}); err == nil {
		t.Fatal("expected error for 403 response")
	}
}
