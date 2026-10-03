// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package kubecache

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestClear_DeletesTheDirectoryAndEverythingInIt: entries, profiles and lock files of every cluster
// go, and so does the directory; a second Clear finds nothing and is not an error.
func TestClear_DeletesTheDirectoryAndEverythingInIt(t *testing.T) {
	c := newCache(t)
	if err := c.Put(entry(time.Hour)); err != nil {
		t.Fatal(err)
	}
	other := entry(time.Hour)
	other.ClusterID = "44444444-4444-4444-8444-444444444444"
	if err := c.Put(other); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(c.Dir(), cid+".lock"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	cleared, err := Clear(c.Dir())
	if err != nil || !cleared {
		t.Fatalf("Clear = %v, %v; want true, nil", cleared, err)
	}
	if _, err := os.Lstat(c.Dir()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the cache directory survived: %v", err)
	}

	cleared, err = Clear(c.Dir())
	if err != nil || cleared {
		t.Errorf("Clear of a missing directory = %v, %v; want false, nil", cleared, err)
	}
}

// TestClear_RefusesASymlinkedDirectory: the CLI never wrote a credential through a link (Open
// refuses one), so Clear does not delete through one either. The link and its target both survive.
func TestClear_RefusesASymlinkedDirectory(t *testing.T) {
	target := t.TempDir()
	keep := filepath.Join(target, "not-ours.json")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "kubecache")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	cleared, err := Clear(link)
	if !errors.Is(err, ErrInsecure) || cleared || !strings.Contains(err.Error(), "is a symlink") {
		t.Fatalf("Clear(symlink) = %v, %v; want false and ErrInsecure naming the symlink", cleared, err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Errorf("the link was deleted: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("the link's target lost a file: %v", err)
	}
}

// TestClear_RefusesAFile: a file where the directory should be is not the cache.
func TestClear_RefusesAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kubecache")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if cleared, err := Clear(path); !errors.Is(err, ErrInsecure) || cleared {
		t.Fatalf("Clear(file) = %v, %v; want false and ErrInsecure", cleared, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the file was deleted: %v", err)
	}
}

// TestClear_DoesNotFollowALinkInside: a symlink planted inside the cache is removed as a link; what
// it points at, outside the cache, is untouched.
func TestClear_DoesNotFollowALinkInside(t *testing.T) {
	c := newCache(t)
	outside := t.TempDir()
	keep := filepath.Join(outside, "keep")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(c.Dir(), "planted")); err != nil {
		t.Fatal(err)
	}
	if _, err := Clear(c.Dir()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("Clear followed a link out of the cache: %v", err)
	}
}

// TestClear_FailuresAreErrors: a directory whose entries cannot be removed, and a path that cannot
// be inspected, are errors naming the path, never a quiet success.
func TestClear_FailuresAreErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the directory's write bit")
	}
	t.Run("undeletable entries", func(t *testing.T) {
		c := newCache(t)
		if err := c.Put(entry(time.Hour)); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(c.Dir(), 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(c.Dir(), 0o700) })
		cleared, err := Clear(c.Dir())
		if err == nil || cleared {
			t.Fatalf("Clear = %v, %v; want an error", cleared, err)
		}
		if got, _ := c.Get(cid, entry(0).Tier); got == nil {
			t.Error("the test did not exercise a failure: the entry is gone")
		}
	})
	t.Run("uninspectable path", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "file")
		if err := os.WriteFile(file, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if cleared, err := Clear(filepath.Join(file, "kubecache")); err == nil || cleared {
			t.Fatalf("Clear under a file = %v, %v; want an error", cleared, err)
		}
	})
}
