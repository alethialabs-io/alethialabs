// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"os"
	"path/filepath"
	"testing"
)

// TestTail_AddOnInstallSourcePredicates pins the two delivery-rail predicates: only the
// literal "git" is a BYO chart, and only the literal "manifest" is the kubectl rail — every
// other value (including the empty default) is a Helm chart.
func TestTail_AddOnInstallSourcePredicates(t *testing.T) {
	cases := []struct {
		source     string
		isGit      bool
		isManifest bool
	}{
		{"git", true, false},
		{"manifest", false, true},
		{"helm", false, false},
		{"", false, false},
		{"Git", false, false},
	}
	for _, c := range cases {
		a := AddOnInstall{Source: c.source}
		if got := a.IsGitSource(); got != c.isGit {
			t.Errorf("IsGitSource(%q) = %v, want %v", c.source, got, c.isGit)
		}
		if got := a.IsManifestSource(); got != c.isManifest {
			t.Errorf("IsManifestSource(%q) = %v, want %v", c.source, got, c.isManifest)
		}
	}
}

// TestTail_ConnectorCredentialFor pins the (category, slug) lookup: an exact match on BOTH
// coordinates returns the decrypted fields, and anything else returns nil rather than a
// neighbouring connector's credential.
func TestTail_ConnectorCredentialFor(t *testing.T) {
	cfg := &ProjectConfig{ConnectorCredentials: []ConnectorCredential{
		{Category: "secrets", Slug: "vault", Credentials: map[string]string{"token": "v"}},
		{Category: "registry", Slug: "ghcr", Credentials: map[string]string{"pat": "g"}},
	}}

	got := cfg.ConnectorCredentialFor("registry", "ghcr")
	if got["pat"] != "g" {
		t.Fatalf("ConnectorCredentialFor(registry, ghcr) = %v, want the ghcr pat", got)
	}
	if cfg.ConnectorCredentialFor("secrets", "ghcr") != nil {
		t.Error("a matching slug under the wrong category must not match")
	}
	if cfg.ConnectorCredentialFor("registry", "vault") != nil {
		t.Error("a matching category with the wrong slug must not match")
	}
	if (&ProjectConfig{}).ConnectorCredentialFor("registry", "ghcr") != nil {
		t.Error("no attached credentials must resolve to nil")
	}
}

// TestTail_CliConfigWithNoConfigDir pins the fail-soft behaviour when the OS cannot name a
// user config directory: CliConfigPath surfaces the error, LoadCliConfig degrades to the zero
// config (an unset context is not an error) and SaveCliConfig refuses.
func TestTail_CliConfigWithNoConfigDir(t *testing.T) {
	// Both are cleared so the lookup fails on macOS ($HOME) and Linux ($XDG_CONFIG_HOME/$HOME).
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	if _, err := os.UserConfigDir(); err == nil {
		t.Skip("this platform resolves a config dir without HOME/XDG_CONFIG_HOME")
	}

	if path, err := CliConfigPath(); err == nil {
		t.Fatalf("CliConfigPath() = %q, want an error with no config dir", path)
	}
	if cfg := LoadCliConfig(); cfg != (CliConfig{}) {
		t.Fatalf("LoadCliConfig() = %#v, want the zero config", cfg)
	}
	if err := SaveCliConfig(CliConfig{ActiveOrgID: "org"}); err == nil {
		t.Fatal("SaveCliConfig() = nil, want an error with no config dir")
	}
}

// TestTail_SaveCliConfigCannotCreateDir pins that SaveCliConfig surfaces the mkdir failure when
// the "alethia" config directory cannot be created because a regular file already occupies its
// path — it must not silently drop the org context.
func TestTail_SaveCliConfigCannotCreateDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)

	path, err := CliConfigPath()
	if err != nil {
		t.Fatalf("CliConfigPath: %v", err)
	}
	dir := filepath.Dir(path) // <configdir>/alethia
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		t.Fatalf("mkdir config root: %v", err)
	}
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write blocking file: %v", err)
	}

	if err := SaveCliConfig(CliConfig{ActiveOrgID: "org"}); err == nil {
		t.Fatal("SaveCliConfig() = nil, want the mkdir failure surfaced")
	}
}

// TestTail_LoadCliConfigIgnoresUnreadableFile pins that a config file that is not readable as
// JSON — here a directory where the file should be — yields the zero config instead of an error.
func TestTail_LoadCliConfigIgnoresUnreadableFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)

	path, err := CliConfigPath()
	if err != nil {
		t.Fatalf("CliConfigPath: %v", err)
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir over config path: %v", err)
	}
	if cfg := LoadCliConfig(); cfg != (CliConfig{}) {
		t.Fatalf("LoadCliConfig() = %#v, want the zero config", cfg)
	}
}
