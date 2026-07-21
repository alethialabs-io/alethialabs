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
	"time"
)

func resetTofuSeams(t *testing.T) {
	t.Helper()
	origLookPath := lookPath
	origHTTPGet := httpGet
	t.Cleanup(func() {
		lookPath = origLookPath
		httpGet = origHTTPGet
	})
}

func TestCancelGracePeriod(t *testing.T) {
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "")
	if got := cancelGracePeriod(); got != DefaultCancelGracePeriod {
		t.Fatalf("default cancelGracePeriod = %s, want %s", got, DefaultCancelGracePeriod)
	}
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "0")
	if got := cancelGracePeriod(); got != 0 {
		t.Fatalf("zero cancelGracePeriod = %s, want 0", got)
	}
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "17")
	if got := cancelGracePeriod(); got != 17*time.Second {
		t.Fatalf("configured cancelGracePeriod = %s, want 17s", got)
	}
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "-1")
	if got := cancelGracePeriod(); got != DefaultCancelGracePeriod {
		t.Fatalf("negative cancelGracePeriod = %s, want default", got)
	}
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "bad")
	if got := cancelGracePeriod(); got != DefaultCancelGracePeriod {
		t.Fatalf("invalid cancelGracePeriod = %s, want default", got)
	}
}

func TestOverrideTfvarsFromMapWritesJSONAndReportsMarshalErrors(t *testing.T) {
	dir := t.TempDir()
	path, err := OverrideTfvarsFromMap(dir, map[string]interface{}{
		"name": "alethia",
		"tags": []string{"managed", "test"},
	})
	if err != nil {
		t.Fatalf("OverrideTfvarsFromMap: %v", err)
	}
	if path != filepath.Join(dir, "tofu.tfvars.json") {
		t.Fatalf("path = %q", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read tfvars: %v", err)
	}
	if !strings.HasSuffix(string(data), "\n") || !strings.Contains(string(data), `"name": "alethia"`) {
		t.Fatalf("tfvars JSON not formatted as expected:\n%s", data)
	}

	_, err = OverrideTfvarsFromMap(dir, map[string]interface{}{"bad": func() {}})
	if err == nil || !strings.Contains(err.Error(), "failed to encode tfvars") {
		t.Fatalf("marshal error = %v, want encode failure", err)
	}
}

func TestSHA256For(t *testing.T) {
	got, err := sha256For("abc  other.zip\n0123  tofu.zip\n", "tofu.zip")
	if err != nil {
		t.Fatalf("sha256For: %v", err)
	}
	if got != "0123" {
		t.Fatalf("sha256For = %q, want 0123", got)
	}
	if _, err := sha256For("abc  other.zip\n", "missing.zip"); err == nil {
		t.Fatal("sha256For returned nil error for missing asset")
	}
}

func TestDownloadTofuVerifiesChecksumAndExtractsBinary(t *testing.T) {
	resetTofuSeams(t)

	zipBytes := tofuZip(t, "bin/tofu", "fake-tofu")
	sum := fmt.Sprintf("%x", sha256.Sum256(zipBytes))
	var requested []string
	httpGet = func(_ context.Context, url string) ([]byte, error) {
		requested = append(requested, url)
		switch {
		case strings.HasSuffix(url, ".zip"):
			return zipBytes, nil
		case strings.HasSuffix(url, "SHA256SUMS"):
			asset := filepath.Base(requested[0])
			return []byte(sum + "  " + asset + "\n"), nil
		default:
			return nil, fmt.Errorf("unexpected URL %s", url)
		}
	}

	dst := filepath.Join(t.TempDir(), "tofu_1.2.3")
	if err := downloadTofu(context.Background(), "1.2.3", dst); err != nil {
		t.Fatalf("downloadTofu: %v", err)
	}
	data, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read extracted tofu: %v", err)
	}
	if string(data) != "fake-tofu" {
		t.Fatalf("extracted tofu = %q, want fake-tofu", data)
	}
	if info, err := os.Stat(dst); err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("mode = %v err=%v, want 0755", info.Mode().Perm(), err)
	}
}

func TestDownloadTofuFailureModes(t *testing.T) {
	resetTofuSeams(t)

	tests := []struct {
		name string
		get  func(context.Context, string) ([]byte, error)
		want string
	}{
		{
			name: "asset download fails",
			get: func(context.Context, string) ([]byte, error) {
				return nil, errors.New("network down")
			},
			want: "failed to download",
		},
		{
			name: "sums download fails",
			get: func(_ context.Context, url string) ([]byte, error) {
				if strings.HasSuffix(url, ".zip") {
					return tofuZip(t, "tofu", "x"), nil
				}
				return nil, errors.New("sums unavailable")
			},
			want: "failed to download SHA256SUMS",
		},
		{
			name: "checksum mismatch",
			get: func(_ context.Context, url string) ([]byte, error) {
				if strings.HasSuffix(url, ".zip") {
					return tofuZip(t, "tofu", "x"), nil
				}
				return []byte("bad  " + assetName() + "\n"), nil
			},
			want: "checksum mismatch",
		},
		{
			name: "zip lacks tofu binary",
			get: func(_ context.Context, url string) ([]byte, error) {
				zipBytes := tofuZip(t, "README.md", "x")
				if strings.HasSuffix(url, ".zip") {
					return zipBytes, nil
				}
				return []byte(fmt.Sprintf("%x", sha256.Sum256(zipBytes)) + "  " + assetNameForURL(url) + "\n"), nil
			},
			want: "`tofu` binary not found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			httpGet = tt.get
			err := downloadTofu(context.Background(), "1.2.3", filepath.Join(t.TempDir(), "tofu"))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("downloadTofu error = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func TestEnsureBinaryUsesPathCacheThenDownload(t *testing.T) {
	resetTofuSeams(t)

	t.Run("PATH tofu wins", func(t *testing.T) {
		lookPath = func(name string) (string, error) {
			if name != "tofu" {
				t.Fatalf("lookPath name = %q", name)
			}
			return "/usr/local/bin/tofu", nil
		}
		got, err := ensureBinary(context.Background(), "1.2.3")
		if err != nil {
			t.Fatalf("ensureBinary: %v", err)
		}
		if got != "/usr/local/bin/tofu" {
			t.Fatalf("ensureBinary = %q, want PATH tofu", got)
		}
	})

	t.Run("cached version wins before download", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		lookPath = func(string) (string, error) { return "", errors.New("missing") }
		cached := filepath.Join(home, ".alethia", "bin", "tofu_1.2.3")
		if err := os.MkdirAll(filepath.Dir(cached), 0755); err != nil {
			t.Fatalf("mkdir cache: %v", err)
		}
		if err := os.WriteFile(cached, []byte("cached"), 0755); err != nil {
			t.Fatalf("write cache: %v", err)
		}
		httpGet = func(context.Context, string) ([]byte, error) {
			t.Fatal("ensureBinary downloaded despite cached tofu")
			return nil, nil
		}
		got, err := ensureBinary(context.Background(), "1.2.3")
		if err != nil {
			t.Fatalf("ensureBinary: %v", err)
		}
		if got != cached {
			t.Fatalf("ensureBinary = %q, want %q", got, cached)
		}
	})

	t.Run("downloads into cache when missing", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		lookPath = func(string) (string, error) { return "", errors.New("missing") }
		zipBytes := tofuZip(t, "tofu", "downloaded")
		sum := fmt.Sprintf("%x", sha256.Sum256(zipBytes))
		httpGet = func(_ context.Context, url string) ([]byte, error) {
			if strings.HasSuffix(url, ".zip") {
				return zipBytes, nil
			}
			return []byte(sum + "  " + assetNameForURL(url) + "\n"), nil
		}
		got, err := ensureBinary(context.Background(), "1.2.3")
		if err != nil {
			t.Fatalf("ensureBinary: %v", err)
		}
		if want := filepath.Join(home, ".alethia", "bin", "tofu_1.2.3"); got != want {
			t.Fatalf("ensureBinary = %q, want %q", got, want)
		}
		if data, err := os.ReadFile(got); err != nil || string(data) != "downloaded" {
			t.Fatalf("cached download data = %q err=%v", data, err)
		}
	})
}

func tofuZip(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
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

func assetNameForURL(url string) string {
	return assetName()
}

func assetName() string {
	return fmt.Sprintf("tofu_1.2.3_%s_%s.zip", runtime.GOOS, runtime.GOARCH)
}
