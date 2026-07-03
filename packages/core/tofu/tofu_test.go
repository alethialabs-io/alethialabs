// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"os"
	"path/filepath"
	"testing"
)

// TestEnsurePluginCache_Default verifies that with no TF_PLUGIN_CACHE_DIR set,
// ensurePluginCache defaults it to ~/.alethia/plugin-cache, creates the dir, and
// publishes it via the process env so the child `tofu` inherits it.
func TestEnsurePluginCache_Default(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// On some platforms os.UserHomeDir consults other vars; normalize.
	t.Setenv("USERPROFILE", home)
	t.Setenv("TF_PLUGIN_CACHE_DIR", "")
	// t.Setenv with "" sets it to empty; clear it so the unset branch runs.
	os.Unsetenv("TF_PLUGIN_CACHE_DIR")

	ensurePluginCache()

	got := os.Getenv("TF_PLUGIN_CACHE_DIR")
	want := filepath.Join(home, ".alethia", "plugin-cache")
	if got != want {
		t.Fatalf("expected TF_PLUGIN_CACHE_DIR=%q, got %q", want, got)
	}
	if info, err := os.Stat(want); err != nil || !info.IsDir() {
		t.Fatalf("expected cache dir %q to exist, err=%v", want, err)
	}
}

// TestEnsurePluginCache_Honored verifies that an existing TF_PLUGIN_CACHE_DIR (e.g.
// the cache baked into the runner image) is preserved and created if missing.
func TestEnsurePluginCache_Honored(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "baked-cache")
	t.Setenv("TF_PLUGIN_CACHE_DIR", dir)

	ensurePluginCache()

	if got := os.Getenv("TF_PLUGIN_CACHE_DIR"); got != dir {
		t.Fatalf("expected cache dir unchanged %q, got %q", dir, got)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("expected cache dir %q to be created, err=%v", dir, err)
	}
}
