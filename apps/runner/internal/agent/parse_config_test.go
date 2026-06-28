// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "testing"

func TestParseRunnerDeployConfig(t *testing.T) {
	cfg, err := parseRunnerDeployConfig(map[string]any{
		"runner_id":    "r1",
		"runner_token": "t1",
		"cpu":          2,
		"memory":       1024,
	})
	if err != nil {
		t.Fatalf("valid config: %v", err)
	}
	if cfg.RunnerID != "r1" || cfg.RunnerToken != "t1" || cfg.CPU != 2 || cfg.Memory != 1024 {
		t.Errorf("parsed config mismatch: %+v", cfg)
	}

	if _, err := parseRunnerDeployConfig(map[string]any{"runner_id": "r1"}); err == nil {
		t.Error("missing runner_token should error")
	}
	if _, err := parseRunnerDeployConfig(map[string]any{"runner_token": "t1"}); err == nil {
		t.Error("missing runner_id should error")
	}
}

func TestParseRunnerDestroyConfig(t *testing.T) {
	if _, err := parseRunnerDestroyConfig(map[string]any{"runner_id": "r1"}); err != nil {
		t.Fatalf("valid destroy config: %v", err)
	}
	if _, err := parseRunnerDestroyConfig(map[string]any{}); err == nil {
		t.Error("missing runner_id should error")
	}
}

func TestResolveInstanceID_EnvOverrideWins(t *testing.T) {
	t.Setenv("ALETHIA_RUNNER_INSTANCE_ID", "vm-42")
	if got := resolveInstanceID(); got != "vm-42" {
		t.Errorf("resolveInstanceID() = %q, want vm-42", got)
	}
}
