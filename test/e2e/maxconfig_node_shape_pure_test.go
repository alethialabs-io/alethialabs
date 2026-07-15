// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the heavy-surface node-shape guard — NO build tag, NO cloud.
// Verifies the guard fails fast on an undersized shape AND that the SHIPPED heavy profile
// (fixtures/cluster_json.heavy.aws.json) actually clears the floor, so the nightly's injected shape
// isn't silently under-provisioned.
package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// enableHeavy turns on both dimensions the guard gates on + REQUIRE (hard-fail mode).
func enableHeavy(t *testing.T) {
	t.Helper()
	t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
	t.Setenv("ALETHIA_E2E_MAX_CONFIG", "1")
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
}

func TestMaxConfigNodeShapeGuard(t *testing.T) {
	t.Run("noop when heavy surface is off", func(t *testing.T) {
		// Neither dimension on: even a tiny shape must not trip the guard.
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "")
		t.Setenv("ALETHIA_E2E_MAX_CONFIG", "")
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1)}}
		if fatal, msg := t2RequireMaxConfigNodeShape(snap); msg != "" || fatal {
			t.Fatalf("guard tripped when heavy surface is off: fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on too-few nodes", func(t *testing.T) {
		enableHeavy(t)
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1), "instance_types": []any{"m5.large"}}}
		fatal, msg := t2RequireMaxConfigNodeShape(snap)
		if !fatal || msg == "" {
			t.Fatalf("expected hard fail on 1 node, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on insufficient total capacity", func(t *testing.T) {
		enableHeavy(t)
		// 3 nodes clears the node-count floor, but 2 vCPU × 3 = 6 < heavyMinVCPU(12).
		snap := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(3),
			"node_size":         map[string]any{"vcpu": float64(2), "memory_gb": float64(8)},
		}}
		fatal, msg := t2RequireMaxConfigNodeShape(snap)
		if !fatal || msg == "" {
			t.Fatalf("expected hard fail on undersized node_size, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on missing cluster block", func(t *testing.T) {
		enableHeavy(t)
		if fatal, msg := t2RequireMaxConfigNodeShape(map[string]any{}); !fatal || msg == "" {
			t.Fatalf("expected hard fail on missing cluster block, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("warns (not fatal) when REQUIRE is unset", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
		t.Setenv("ALETHIA_E2E_MAX_CONFIG", "1")
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "") // local dev: warn, don't fail
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1)}}
		fatal, msg := t2RequireMaxConfigNodeShape(snap)
		if fatal {
			t.Fatalf("guard must warn (not fail) off CI, got fatal=%v", fatal)
		}
		if msg == "" {
			t.Fatal("guard should still surface a warning message off CI")
		}
	})

	t.Run("shipped heavy profile clears the floor", func(t *testing.T) {
		enableHeavy(t)
		snap := map[string]any{"cluster": loadHeavyProfile(t)}
		if fatal, msg := t2RequireMaxConfigNodeShape(snap); msg != "" || fatal {
			t.Fatalf("the shipped heavy profile must satisfy the guard, but it did not: fatal=%v msg=%q", fatal, msg)
		}
	})
}

// loadHeavyProfile reads fixtures/cluster_json.heavy.aws.json as the cluster block.
func loadHeavyProfile(t *testing.T) map[string]any {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the e2e package directory")
	}
	path := filepath.Join(filepath.Dir(thisFile), "fixtures", "cluster_json.heavy.aws.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read heavy profile fixture: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse heavy profile fixture: %v", err)
	}
	return m
}
