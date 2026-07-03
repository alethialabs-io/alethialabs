// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCopyDir_PreservesSymlinks guards the per-job copy of a pre-initialized
// template: provider entries under .terraform/providers are symlinks into the shared
// plugin cache and MUST be copied as symlinks, not dereferenced (which would copy
// hundreds of MB per job and fail on directory targets). Regular files/dirs copy
// normally.
func TestCopyDir_PreservesSymlinks(t *testing.T) {
	src := t.TempDir()
	dst := filepath.Join(t.TempDir(), "out")

	// A regular file.
	if err := os.WriteFile(filepath.Join(src, "main.tf"), []byte("content"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A nested regular file (simulates .terraform/modules/<m>/file).
	nested := filepath.Join(src, ".terraform", "modules", "vpc")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "vpc.tf"), []byte("module"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A symlink pointing at an absolute path outside the tree (simulates a provider
	// symlink into TF_PLUGIN_CACHE_DIR).
	cacheTarget := filepath.Join(t.TempDir(), "plugin-cache", "aws", "5.100.0")
	if err := os.MkdirAll(cacheTarget, 0o755); err != nil {
		t.Fatal(err)
	}
	provDir := filepath.Join(src, ".terraform", "providers", "registry.opentofu.org", "hashicorp", "aws")
	if err := os.MkdirAll(provDir, 0o755); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(provDir, "5.100.0")
	if err := os.Symlink(cacheTarget, linkPath); err != nil {
		t.Fatal(err)
	}

	if err := copyDir(src, dst); err != nil {
		t.Fatalf("copyDir: %v", err)
	}

	// Regular files copied with content.
	if b, err := os.ReadFile(filepath.Join(dst, "main.tf")); err != nil || string(b) != "content" {
		t.Errorf("main.tf not copied: %q err=%v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, ".terraform", "modules", "vpc", "vpc.tf")); err != nil || string(b) != "module" {
		t.Errorf("nested module file not copied: %q err=%v", b, err)
	}

	// Symlink preserved as a symlink (not dereferenced) and pointing at the same target.
	copiedLink := filepath.Join(dst, ".terraform", "providers", "registry.opentofu.org", "hashicorp", "aws", "5.100.0")
	fi, err := os.Lstat(copiedLink)
	if err != nil {
		t.Fatalf("lstat copied link: %v", err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected %s to be a symlink, got mode %v", copiedLink, fi.Mode())
	}
	got, err := os.Readlink(copiedLink)
	if err != nil {
		t.Fatalf("readlink: %v", err)
	}
	if got != cacheTarget {
		t.Errorf("symlink target = %q, want %q", got, cacheTarget)
	}
}
