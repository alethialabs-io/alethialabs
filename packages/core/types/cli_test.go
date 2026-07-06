// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import "testing"

func TestResolveWebOrigin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	// 1. Nothing set → hosted default.
	t.Setenv("ALETHIA_WEB_ORIGIN", "")
	if origin, src := ResolveWebOrigin(); origin != DefaultWebOrigin || src != WebOriginFromDefault {
		t.Errorf("default: got %s/%s, want %s/default", origin, src, DefaultWebOrigin)
	}

	// 2. Config set → config wins over default.
	if err := SaveCliConfig(CliConfig{WebOrigin: "https://dev.alethialabs.io"}); err != nil {
		t.Fatal(err)
	}
	if origin, src := ResolveWebOrigin(); origin != "https://dev.alethialabs.io" || src != WebOriginFromConfig {
		t.Errorf("config: got %s/%s, want dev/config", origin, src)
	}

	// 3. Env set → env wins over config.
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://app.example.com")
	if origin, src := ResolveWebOrigin(); origin != "https://app.example.com" || src != WebOriginFromEnv {
		t.Errorf("env: got %s/%s, want app/env", origin, src)
	}
}

func TestCliConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	want := CliConfig{WebOrigin: "https://x.io", ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}
	if err := SaveCliConfig(want); err != nil {
		t.Fatal(err)
	}
	got := LoadCliConfig()
	if got != want {
		t.Errorf("round-trip mismatch: got %+v want %+v", got, want)
	}
}

func TestLoadCliConfigMissing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	// No file → zero-value config, no error.
	if got := LoadCliConfig(); got != (CliConfig{}) {
		t.Errorf("expected zero config, got %+v", got)
	}
}
