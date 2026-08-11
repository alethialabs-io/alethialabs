// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// hygCoreTofuAsset returns the release asset name downloadTofu will ask for at ver on
// this OS/arch — the name the fake SHA256SUMS body must key its checksum under.
func hygCoreTofuAsset(ver string) string {
	return fmt.Sprintf("tofu_%s_%s_%s.zip", ver, runtime.GOOS, runtime.GOARCH)
}

// hygCoreTofuGoodZip builds a well-formed release zip carrying `tofu` with the given body.
func hygCoreTofuGoodZip(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("tofu")
	if err != nil {
		t.Fatalf("create zip entry: %v", err)
	}
	if _, err := w.Write([]byte(body)); err != nil {
		t.Fatalf("write zip entry: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// hygCoreTofuBadCRCZip builds a zip whose `tofu` entry declares a WRONG CRC32. The archive
// itself opens fine and its bytes stream out fine, so the failure surfaces from io.Copy
// only AFTER the whole payload has been written — exactly the mid-copy failure (disk full,
// killed process, corrupt payload) that used to leave a truncated executable at dst.
func hygCoreTofuBadCRCZip(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	hdr := &zip.FileHeader{Name: "tofu", Method: zip.Store}
	w, err := zw.CreateRaw(hdr)
	if err != nil {
		t.Fatalf("CreateRaw: %v", err)
	}
	hdr.CRC32 = 0xdeadbeef // deliberately wrong: io.Copy fails at the end of the entry
	hdr.UncompressedSize64 = uint64(len(body))
	hdr.CompressedSize64 = uint64(len(body))
	if _, err := w.Write([]byte(body)); err != nil {
		t.Fatalf("write raw zip entry: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// hygCoreTofuServe points the httpGet seam at zipBytes plus a SHA256SUMS body that matches
// it, so the download reaches extraction instead of failing checksum verification. It
// returns a counter of the calls made.
func hygCoreTofuServe(t *testing.T, ver string, zipBytes []byte) *int {
	t.Helper()
	calls := 0
	sum := fmt.Sprintf("%x", sha256.Sum256(zipBytes))
	httpGet = func(_ context.Context, url string) ([]byte, error) {
		calls++
		if strings.HasSuffix(url, ".zip") {
			return zipBytes, nil
		}
		return []byte(sum + "  " + hygCoreTofuAsset(ver) + "\n"), nil
	}
	return &calls
}

// hygCoreTofuRunnableStub writes an executable no-op stub at path — a file that both looks
// like a binary to os.Stat AND actually runs, which is what a healthy cache entry must be.
func hygCoreTofuRunnableStub(t *testing.T, path string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the cache probe runs the binary; the shell stub is POSIX-only")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir cache dir: %v", err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write runnable stub: %v", err)
	}
}

// TestHygCoreTofuDownloadIsAtomic proves the extraction is all-or-nothing: a good zip lands
// the binary at dst (so the write path really is reached), and a payload that fails part-way
// through io.Copy leaves NOTHING at dst and no temp file behind.
func TestHygCoreTofuDownloadIsAtomic(t *testing.T) {
	resetTofuSeams(t)

	t.Run("a good payload lands at dst", func(t *testing.T) {
		hygCoreTofuServe(t, "1.2.3", hygCoreTofuGoodZip(t, "real-tofu"))

		dir := t.TempDir()
		dst := filepath.Join(dir, "tofu_1.2.3")
		if err := downloadTofu(context.Background(), "1.2.3", dst); err != nil {
			t.Fatalf("downloadTofu: %v", err)
		}
		data, err := os.ReadFile(dst)
		if err != nil || string(data) != "real-tofu" {
			t.Fatalf("extracted binary = %q err=%v, want real-tofu", data, err)
		}
		if info, err := os.Stat(dst); err != nil || info.Mode().Perm() != 0o755 {
			t.Fatalf("mode = %v err=%v, want 0755 — the rename must carry the exec bit", info.Mode().Perm(), err)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 1 {
			t.Fatalf("dir holds %d entries, want only the binary — a temp file leaked", len(entries))
		}
	})

	t.Run("a mid-copy failure leaves no file at dst", func(t *testing.T) {
		hygCoreTofuServe(t, "1.2.3", hygCoreTofuBadCRCZip(t, "CORRUPT-TOFU-BYTES"))

		dir := t.TempDir()
		dst := filepath.Join(dir, "tofu_1.2.3")
		// Precondition: nothing at dst yet, and the failure must come from the extraction
		// itself — not from an earlier download/checksum branch that never writes.
		if _, err := os.Stat(dst); err == nil {
			t.Fatalf("precondition: %s already exists", dst)
		}

		err := downloadTofu(context.Background(), "1.2.3", dst)
		if err == nil {
			t.Fatal("downloadTofu succeeded on a corrupt payload")
		}
		if !strings.Contains(err.Error(), "failed to extract") {
			t.Fatalf("downloadTofu error = %v, want the extraction failure (the copy must have been reached)", err)
		}
		if _, statErr := os.Stat(dst); statErr == nil {
			t.Fatalf("POISONED CACHE: a failed extraction left a file at %s", dst)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Fatalf("dir holds %d entries after a failed extraction, want 0 — the temp file leaked", len(entries))
		}
	})
}

// TestHygCoreTofuDownloadReportsUncreatableTemp covers the temp-file creation failure: the
// destination directory does not exist, so no extraction can start.
func TestHygCoreTofuDownloadReportsUncreatableTemp(t *testing.T) {
	resetTofuSeams(t)
	hygCoreTofuServe(t, "1.2.3", hygCoreTofuGoodZip(t, "real-tofu"))

	dst := filepath.Join(t.TempDir(), "no-such-dir", "tofu_1.2.3")
	err := downloadTofu(context.Background(), "1.2.3", dst)
	if err == nil || !strings.Contains(err.Error(), "failed to create temp file") {
		t.Fatalf("downloadTofu error = %v, want the temp-file failure", err)
	}
}

// TestHygCoreTofuEnsureBinaryRejectsPoisonedCache proves the cache probe is not
// existence-only: a zero-byte, a non-executable and a truncated-garbage file at the cache
// path are all rejected and re-downloaded, so one interrupted download cannot brick the
// host forever.
func TestHygCoreTofuEnsureBinaryRejectsPoisonedCache(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
		mode    os.FileMode
	}{
		{name: "zero byte", content: []byte{}, mode: 0o755},
		{name: "not executable", content: []byte("#!/bin/sh\nexit 0\n"), mode: 0o644},
		{name: "truncated image", content: []byte("\x7fELF\x02\x01\x01"), mode: 0o755},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetTofuSeams(t)
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("USERPROFILE", home)
			lookPath = func(string) (string, error) { return "", errors.New("no tofu on PATH") }

			cached := filepath.Join(home, ".alethia", "bin", "tofu_1.2.3")
			if err := os.MkdirAll(filepath.Dir(cached), 0o755); err != nil {
				t.Fatalf("mkdir cache dir: %v", err)
			}
			if err := os.WriteFile(cached, tt.content, tt.mode); err != nil {
				t.Fatalf("plant poisoned cache: %v", err)
			}
			// Precondition: the poison really is on disk, so an existence-only probe
			// would have blessed it and skipped the download below.
			if _, err := os.Stat(cached); err != nil {
				t.Fatalf("precondition: poisoned file missing at %s: %v", cached, err)
			}

			calls := hygCoreTofuServe(t, "1.2.3", hygCoreTofuGoodZip(t, "fresh-tofu"))
			got, err := ensureBinary(context.Background(), "1.2.3")
			if err != nil {
				t.Fatalf("ensureBinary: %v", err)
			}
			if got != cached {
				t.Fatalf("ensureBinary = %q, want %q", got, cached)
			}
			if *calls == 0 {
				t.Fatal("ensureBinary returned the poisoned cache entry without re-downloading")
			}
			if data, err := os.ReadFile(cached); err != nil || string(data) != "fresh-tofu" {
				t.Fatalf("cached binary = %q err=%v, want the re-downloaded fresh-tofu", data, err)
			}
		})
	}
}

// TestHygCoreTofuEnsureBinaryKeepsRunnableCache is the other half of the probe: a cache
// entry that actually runs must still short-circuit the download.
func TestHygCoreTofuEnsureBinaryKeepsRunnableCache(t *testing.T) {
	resetTofuSeams(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	lookPath = func(string) (string, error) { return "", errors.New("no tofu on PATH") }

	cached := filepath.Join(home, ".alethia", "bin", "tofu_1.2.3")
	hygCoreTofuRunnableStub(t, cached)
	httpGet = func(context.Context, string) ([]byte, error) {
		t.Fatal("ensureBinary re-downloaded despite a runnable cached binary")
		return nil, nil
	}

	got, err := ensureBinary(context.Background(), "1.2.3")
	if err != nil {
		t.Fatalf("ensureBinary: %v", err)
	}
	if got != cached {
		t.Fatalf("ensureBinary = %q, want the cached %q", got, cached)
	}
}

// TestHygCoreTofuCachedBinaryUsableRejectsNonRegular covers the probe's remaining stat
// branch: a directory at the cache path is not a usable binary.
func TestHygCoreTofuCachedBinaryUsableRejectsNonRegular(t *testing.T) {
	dir := t.TempDir()
	if cachedBinaryUsable(context.Background(), dir) {
		t.Fatal("cachedBinaryUsable accepted a directory")
	}
	if cachedBinaryUsable(context.Background(), filepath.Join(dir, "absent")) {
		t.Fatal("cachedBinaryUsable accepted a missing path")
	}
}
