// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestParseRunnerDeployConfig table-tests parseRunnerDeployConfig across valid
// snapshots, missing-required-field cases, and JSON marshal/unmarshal edges.
func TestParseRunnerDeployConfig(t *testing.T) {
	tests := []struct {
		name     string
		snapshot map[string]any
		wantErr  bool
		check    func(t *testing.T, cfg *runnerDeployConfig)
	}{
		{
			name: "minimal valid",
			snapshot: map[string]any{
				"runner_id":    "r1",
				"runner_token": "t1",
			},
			check: func(t *testing.T, cfg *runnerDeployConfig) {
				if cfg.RunnerID != "r1" || cfg.RunnerToken != "t1" {
					t.Errorf("got id=%q token=%q, want r1/t1", cfg.RunnerID, cfg.RunnerToken)
				}
			},
		},
		{
			name: "full field mapping",
			snapshot: map[string]any{
				"runner_id":        "r2",
				"runner_token":     "t2",
				"runner_name":      "prod-runner",
				"image_tag":        "v1.2.3",
				"region":           "eu-central-1",
				"cloud_provider":   "aws",
				"alethia_url":      "https://alethialabs.io",
				"cpu":              2,
				"memory":           1024,
				"image_repository": "ghcr.io/alethia/runner",
			},
			check: func(t *testing.T, cfg *runnerDeployConfig) {
				if cfg.RunnerName != "prod-runner" || cfg.ImageTag != "v1.2.3" {
					t.Errorf("name/tag mismatch: %+v", cfg)
				}
				if cfg.Region != "eu-central-1" || cfg.CloudProvider != "aws" {
					t.Errorf("region/provider mismatch: %+v", cfg)
				}
				if cfg.AlethiaURL != "https://alethialabs.io" {
					t.Errorf("alethia_url mismatch: %q", cfg.AlethiaURL)
				}
				if cfg.CPU != 2 || cfg.Memory != 1024 {
					t.Errorf("cpu/memory mismatch: cpu=%d memory=%d", cfg.CPU, cfg.Memory)
				}
				if cfg.ImageRepository != "ghcr.io/alethia/runner" {
					t.Errorf("image_repository mismatch: %q", cfg.ImageRepository)
				}
			},
		},
		{
			name: "extra unknown keys ignored",
			snapshot: map[string]any{
				"runner_id":    "r3",
				"runner_token": "t3",
				"unknown_key":  "whatever",
			},
			check: func(t *testing.T, cfg *runnerDeployConfig) {
				if cfg.RunnerID != "r3" {
					t.Errorf("runner_id = %q, want r3", cfg.RunnerID)
				}
			},
		},
		{
			name:     "missing runner_token",
			snapshot: map[string]any{"runner_id": "r1"},
			wantErr:  true,
		},
		{
			name:     "missing runner_id",
			snapshot: map[string]any{"runner_token": "t1"},
			wantErr:  true,
		},
		{
			name:     "empty snapshot",
			snapshot: map[string]any{},
			wantErr:  true,
		},
		{
			name:     "nil snapshot",
			snapshot: nil,
			wantErr:  true,
		},
		{
			name: "empty string credentials rejected",
			snapshot: map[string]any{
				"runner_id":    "",
				"runner_token": "",
			},
			wantErr: true,
		},
		{
			name: "wrong type for cpu (string) fails unmarshal",
			snapshot: map[string]any{
				"runner_id":    "r1",
				"runner_token": "t1",
				"cpu":          "not-a-number",
			},
			wantErr: true,
		},
		{
			name: "unmarshalable value fails marshal",
			snapshot: map[string]any{
				"runner_id":    "r1",
				"runner_token": "t1",
				"bad":          make(chan int),
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := parseRunnerDeployConfig(tt.snapshot)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got cfg=%+v", cfg)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cfg == nil {
				t.Fatal("expected non-nil cfg")
			}
			if tt.check != nil {
				tt.check(t, cfg)
			}
		})
	}
}

// TestParseRunnerDestroyConfig table-tests parseRunnerDestroyConfig: only
// runner_id is required (token is optional for destroy).
func TestParseRunnerDestroyConfig(t *testing.T) {
	tests := []struct {
		name     string
		snapshot map[string]any
		wantErr  bool
		wantID   string
	}{
		{
			name:     "valid with id only",
			snapshot: map[string]any{"runner_id": "r1"},
			wantID:   "r1",
		},
		{
			name: "valid with id and other fields",
			snapshot: map[string]any{
				"runner_id":      "r2",
				"cloud_provider": "gcp",
				"region":         "us-east1",
			},
			wantID: "r2",
		},
		{
			name:     "missing runner_id",
			snapshot: map[string]any{},
			wantErr:  true,
		},
		{
			name:     "nil snapshot",
			snapshot: nil,
			wantErr:  true,
		},
		{
			name:     "empty runner_id rejected",
			snapshot: map[string]any{"runner_id": ""},
			wantErr:  true,
		},
		{
			name: "wrong type for memory fails unmarshal",
			snapshot: map[string]any{
				"runner_id": "r1",
				"memory":    "lots",
			},
			wantErr: true,
		},
		{
			name: "unmarshalable value fails marshal",
			snapshot: map[string]any{
				"runner_id": "r1",
				"bad":       make(chan int),
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := parseRunnerDestroyConfig(tt.snapshot)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got cfg=%+v", cfg)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cfg.RunnerID != tt.wantID {
				t.Errorf("RunnerID = %q, want %q", cfg.RunnerID, tt.wantID)
			}
		})
	}
}

// TestResolveInstanceID_EnvOverride covers the explicit override path of
// resolveInstanceID (the only pure branch; metadata/hostname touch the network
// or host and are out of scope for a unit test).
func TestResolveInstanceID_EnvOverride(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want string
	}{
		{name: "plain value", env: "vm-42", want: "vm-42"},
		{name: "trims surrounding whitespace", env: "  vm-7\n", want: "vm-7"},
		{name: "trims tabs", env: "\tvm-9\t", want: "vm-9"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("ALETHIA_RUNNER_INSTANCE_ID", tt.env)
			if got := resolveInstanceID(); got != tt.want {
				t.Errorf("resolveInstanceID() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestWorkerHome verifies workerHome composes a per-index private HOME under the
// configured base, creates it 0700, and is idempotent across calls.
func TestWorkerHome(t *testing.T) {
	t.Run("uses base env and creates dir", func(t *testing.T) {
		base := t.TempDir()
		t.Setenv("ALETHIA_WORKER_HOME_BASE", base)

		home, err := workerHome(3)
		if err != nil {
			t.Fatalf("workerHome(3): %v", err)
		}
		want := filepath.Join(base, "alethia-worker-3")
		if home != want {
			t.Errorf("home = %q, want %q", home, want)
		}
		info, err := os.Stat(home)
		if err != nil {
			t.Fatalf("stat created home: %v", err)
		}
		if !info.IsDir() {
			t.Errorf("home %q is not a directory", home)
		}
		if perm := info.Mode().Perm(); perm != 0o700 {
			t.Errorf("home perm = %o, want 700", perm)
		}
	})

	t.Run("distinct dirs per index", func(t *testing.T) {
		base := t.TempDir()
		t.Setenv("ALETHIA_WORKER_HOME_BASE", base)

		h0, err := workerHome(0)
		if err != nil {
			t.Fatalf("workerHome(0): %v", err)
		}
		h1, err := workerHome(1)
		if err != nil {
			t.Fatalf("workerHome(1): %v", err)
		}
		if h0 == h1 {
			t.Errorf("expected distinct homes, both = %q", h0)
		}
	})

	t.Run("idempotent on existing dir", func(t *testing.T) {
		base := t.TempDir()
		t.Setenv("ALETHIA_WORKER_HOME_BASE", base)

		first, err := workerHome(5)
		if err != nil {
			t.Fatalf("first workerHome(5): %v", err)
		}
		second, err := workerHome(5)
		if err != nil {
			t.Fatalf("second workerHome(5): %v", err)
		}
		if first != second {
			t.Errorf("non-idempotent: %q vs %q", first, second)
		}
	})

	t.Run("falls back to TempDir when base unset", func(t *testing.T) {
		t.Setenv("ALETHIA_WORKER_HOME_BASE", "")

		home, err := workerHome(2)
		if err != nil {
			t.Fatalf("workerHome(2): %v", err)
		}
		if !strings.HasPrefix(home, os.TempDir()) {
			t.Errorf("home %q not under TempDir %q", home, os.TempDir())
		}
		if filepath.Base(home) != "alethia-worker-2" {
			t.Errorf("base name = %q, want alethia-worker-2", filepath.Base(home))
		}
		_ = os.RemoveAll(home)
	})
}
