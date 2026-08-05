// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestSaveTokensWritesCredentials covers the device-flow writer: it creates the
// config directory and persists the exchange response as the credentials file
// getCredentialsPath resolves.
func TestSaveTokensWritesCredentials(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	credsPath, err := getCredentialsPath()
	if err != nil {
		t.Fatalf("getCredentialsPath: %v", err)
	}
	// Deliberately do NOT pre-create the parent: saveTokens must create it.
	saveTokens(&types.ExchangeResponse{
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		UserEmail:    "x@y.com",
	})

	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatalf("read credentials: %v", err)
	}
	var got types.ExchangeResponse
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.AccessToken != "access-1" || got.RefreshToken != "refresh-1" || got.UserEmail != "x@y.com" {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

// TestPreferencesRoundTrip covers getPreferencesPath/savePreferences/loadPreferences:
// a missing file yields the zero value, and a saved preference reads back.
func TestPreferencesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	path, err := getPreferencesPath()
	if err != nil {
		t.Fatalf("getPreferencesPath: %v", err)
	}
	if !strings.HasSuffix(path, filepath.Join("alethia", "preferences.json")) {
		t.Errorf("unexpected preferences path: %s", path)
	}

	if prefs := loadPreferences(); prefs.HideLoginWarning {
		t.Error("a missing preferences file should load as the zero value")
	}

	savePreferences(cliPreferences{HideLoginWarning: true})
	if prefs := loadPreferences(); !prefs.HideLoginWarning {
		t.Error("HideLoginWarning should survive a save/load round-trip")
	}
}

// TestLoadPreferencesIgnoresGarbage covers the tolerant decode: an unparseable
// preferences file must not fail the CLI, it just yields the zero value.
func TestLoadPreferencesIgnoresGarbage(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	path, err := getPreferencesPath()
	if err != nil {
		t.Fatalf("getPreferencesPath: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if prefs := loadPreferences(); prefs.HideLoginWarning {
		t.Error("a corrupt preferences file should load as the zero value")
	}
}

// TestResolveLoginNoPrompt covers the non-interactive branch of resolveLogin:
// with prompting disabled it must refuse rather than open the device flow.
func TestResolveLoginNoPrompt(t *testing.T) {
	credsPath := isolatedHome(t)
	tok, err := resolveLogin(credsPath, false)
	if err == nil {
		t.Fatalf("resolveLogin with promptLogin=false should error, got token %q", tok)
	}
	if !strings.Contains(err.Error(), "alethia login") {
		t.Errorf("error should point at `alethia login`, got: %v", err)
	}
}
