// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

// Integration test for the provider-plugin cache. Requires the `tofu` binary on
// PATH and network access on the first init (to populate the cache). Run with:
//
//	go test -tags=integration ./packages/core/tofu/...
//
// It proves the cache eliminates re-downloads: a second init in a fresh workdir
// pointed at the warm cache must succeed and be materially faster than the cold one.
package tofu

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const randomProviderConfig = `
terraform {
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}
`

// tofuInit runs `tofu init -backend=false -input=false` in a fresh workdir with the
// given env and returns how long it took.
func tofuInit(t *testing.T, bin string, env []string) (string, time.Duration) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(randomProviderConfig), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	cmd := exec.Command(bin, "init", "-backend=false", "-input=false")
	cmd.Dir = dir
	cmd.Env = env
	start := time.Now()
	out, err := cmd.CombinedOutput()
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("tofu init in %s failed: %v\n%s", dir, err, out)
	}
	return dir, elapsed
}

func TestPluginCache_ReusesAcrossWorkdirs(t *testing.T) {
	bin, err := exec.LookPath("tofu")
	if err != nil {
		t.Skip("tofu binary not on PATH; skipping plugin-cache integration test")
	}

	cacheDir := t.TempDir()
	env := append(os.Environ(), "TF_PLUGIN_CACHE_DIR="+cacheDir)

	// Cold init: resolves + downloads the random provider into the cache.
	_, cold := tofuInit(t, bin, env)

	// The provider must now be present in the cache directory. The first path
	// segment is the registry host (registry.opentofu.org by default), so glob it.
	if entries, _ := filepath.Glob(filepath.Join(cacheDir, "*", "hashicorp", "random", "*")); len(entries) == 0 {
		t.Fatalf("expected hashicorp/random in the plugin cache at %s after cold init", cacheDir)
	}

	// Warm init in a brand-new workdir against the same cache: must succeed and be
	// materially faster (cache hit, no re-download).
	_, warm := tofuInit(t, bin, env)

	t.Logf("cold init: %s, warm init: %s", cold, warm)
	if warm >= cold {
		t.Errorf("expected warm init (cache hit) to be faster than cold init; cold=%s warm=%s", cold, warm)
	}
}
