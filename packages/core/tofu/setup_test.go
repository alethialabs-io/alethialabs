// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestNewTofuCLI_DefaultsNilWriters covers the writer-defaulting branches: a nil stdout or
// stderr must fall back to the process streams rather than nil-panic inside terraform-exec,
// and the resolved stdout is what Output() restores after its io.Discard redirect.
func TestNewTofuCLI_DefaultsNilWriters(t *testing.T) {
	requireTofuOrSkip(t)

	dir, _ := newLifecycleWorkdir(t)
	tf, err := NewTofuCLI(context.Background(), "", dir, nil, nil)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}
	if tf.stdout != os.Stdout {
		t.Fatalf("nil stdout resolved to %#v, want os.Stdout", tf.stdout)
	}
	if tf.version != DefaultIaCVersion {
		t.Fatalf("empty tfVersion resolved to %q, want %q", tf.version, DefaultIaCVersion)
	}
}

// TestNewTofuCLI_ErrorPaths covers the two constructor failures: no usable binary, and a
// working directory terraform-exec refuses.
func TestNewTofuCLI_ErrorPaths(t *testing.T) {
	t.Run("binary cannot be ensured", func(t *testing.T) {
		resetTofuSeams(t)
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		lookPath = func(string) (string, error) { return "", errors.New("no tofu") }
		httpGet = func(context.Context, string) ([]byte, error) { return nil, errors.New("no network") }

		_, err := NewTofuCLI(context.Background(), "1.2.3", t.TempDir(), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "failed to ensure OpenTofu binary") {
			t.Fatalf("NewTofuCLI error = %v, want the ensure-binary failure", err)
		}
	})

	t.Run("working directory does not exist", func(t *testing.T) {
		requireTofuOrSkip(t)
		missing := filepath.Join(t.TempDir(), "no-such-dir")
		_, err := NewTofuCLI(context.Background(), "", missing, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "failed to initialize OpenTofu") {
			t.Fatalf("NewTofuCLI error = %v, want the initialize failure", err)
		}
	})
}

// TestEnsurePluginCache_NoHomeDirIsBestEffort covers the branch where the home directory
// cannot be resolved: the cache is simply skipped, and nothing panics or is exported.
func TestEnsurePluginCache_NoHomeDirIsBestEffort(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	os.Unsetenv("TF_PLUGIN_CACHE_DIR")
	t.Cleanup(func() { os.Unsetenv("TF_PLUGIN_CACHE_DIR") })

	ensurePluginCache()

	if got := os.Getenv("TF_PLUGIN_CACHE_DIR"); got != "" {
		t.Fatalf("TF_PLUGIN_CACHE_DIR = %q, want unset when the home dir is unresolvable", got)
	}
}

// TestEnsureBinary_SetupFailures covers ensureBinary's non-download failure branches: an
// unresolvable home directory and an install directory that cannot be created.
func TestEnsureBinary_SetupFailures(t *testing.T) {
	tests := []struct {
		name string
		// setup prepares HOME and returns the substring the error must contain.
		setup func(t *testing.T) string
	}{
		{
			name: "home directory unresolvable",
			setup: func(t *testing.T) string {
				t.Setenv("HOME", "")
				t.Setenv("USERPROFILE", "")
				return "failed to get home directory"
			},
		},
		{
			name: "install directory blocked by a file",
			setup: func(t *testing.T) string {
				home := t.TempDir()
				// ~/.alethia is a regular FILE, so MkdirAll(~/.alethia/bin) must fail.
				if err := os.WriteFile(filepath.Join(home, ".alethia"), []byte("x"), 0o600); err != nil {
					t.Fatalf("seed blocking file: %v", err)
				}
				t.Setenv("HOME", home)
				t.Setenv("USERPROFILE", home)
				return "failed to create install directory"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetTofuSeams(t)
			lookPath = func(string) (string, error) { return "", errors.New("no tofu") }
			httpGet = func(context.Context, string) ([]byte, error) {
				t.Fatal("ensureBinary attempted a download despite a setup failure")
				return nil, nil
			}
			want := tt.setup(t)

			_, err := ensureBinary(context.Background(), "1.2.3")
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("ensureBinary error = %v, want containing %q", err, want)
			}
		})
	}
}

// TestEnsureBinary_PropagatesDownloadFailure covers the branch that surfaces a download
// error out of ensureBinary unwrapped, and asserts no cache entry is claimed as usable.
func TestEnsureBinary_PropagatesDownloadFailure(t *testing.T) {
	resetTofuSeams(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	lookPath = func(string) (string, error) { return "", errors.New("no tofu") }
	httpGet = func(context.Context, string) ([]byte, error) { return nil, errors.New("registry unreachable") }

	got, err := ensureBinary(context.Background(), "1.2.3")
	if err == nil || !strings.Contains(err.Error(), "registry unreachable") {
		t.Fatalf("ensureBinary error = %v, want the download failure", err)
	}
	if got != "" {
		t.Fatalf("ensureBinary returned path %q alongside an error", got)
	}
}

// TestDownloadTofu_ExtractionFailures covers the post-checksum extraction branches: a
// payload that is not a zip at all, and a destination path that cannot be opened.
func TestDownloadTofu_ExtractionFailures(t *testing.T) {
	tests := []struct {
		name string
		body []byte
		dst  func(t *testing.T) string
		want string
	}{
		{
			name: "payload is not a zip",
			body: []byte("this is not a zip archive"),
			dst:  func(t *testing.T) string { return filepath.Join(t.TempDir(), "tofu") },
			want: "failed to open release zip",
		},
		{
			name: "destination directory missing",
			body: nil, // replaced with a valid zip below
			dst:  func(t *testing.T) string { return filepath.Join(t.TempDir(), "absent", "tofu") },
			want: "no such file or directory",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetTofuSeams(t)
			body := tt.body
			if body == nil {
				body = tofuZip(t, "tofu", "real")
			}
			httpGet = stubReleaseFetch(body)

			err := downloadTofu(context.Background(), "1.2.3", tt.dst(t))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("downloadTofu error = %v, want containing %q", err, tt.want)
			}
		})
	}
}

// sha256Hex returns the lowercase hex SHA256 of b, in SHA256SUMS form.
func sha256Hex(b []byte) string {
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

// stubReleaseFetch returns an httpGet stub that serves body for the release zip and a
// matching SHA256SUMS line, so the checksum gate passes and extraction is reached.
func stubReleaseFetch(body []byte) func(context.Context, string) ([]byte, error) {
	return func(_ context.Context, url string) ([]byte, error) {
		if strings.HasSuffix(url, ".zip") {
			return body, nil
		}
		return []byte(sha256Hex(body) + "  " + assetName() + "\n"), nil
	}
}

// TestDefaultHTTPGet covers the real HTTP fetch seam: a successful read, a non-200
// response, an unreachable host, and a URL the request builder rejects.
func TestDefaultHTTPGet(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("release-bytes"))
	}))
	defer ok.Close()
	teapot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	defer teapot.Close()
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	t.Run("reads the body on 200", func(t *testing.T) {
		got, err := defaultHTTPGet(context.Background(), ok.URL+"/tofu.zip")
		if err != nil {
			t.Fatalf("defaultHTTPGet: %v", err)
		}
		if string(got) != "release-bytes" {
			t.Fatalf("body = %q, want release-bytes", got)
		}
	})

	t.Run("rejects a non-200 status", func(t *testing.T) {
		_, err := defaultHTTPGet(context.Background(), teapot.URL+"/tofu.zip")
		if err == nil || !strings.Contains(err.Error(), "status 418") {
			t.Fatalf("defaultHTTPGet error = %v, want a status failure", err)
		}
	})

	t.Run("surfaces a transport failure", func(t *testing.T) {
		if _, err := defaultHTTPGet(context.Background(), deadURL+"/tofu.zip"); err == nil {
			t.Fatal("defaultHTTPGet succeeded against a closed server")
		}
	})

	t.Run("surfaces a malformed URL", func(t *testing.T) {
		if _, err := defaultHTTPGet(context.Background(), "http://exa\x7fmple.invalid/tofu.zip"); err == nil {
			t.Fatal("defaultHTTPGet accepted a URL with a control character")
		}
	})
}
