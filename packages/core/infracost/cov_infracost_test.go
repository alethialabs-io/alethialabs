// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tailErrBody is a response body whose Read always fails, so fetchBounded's io.ReadAll error
// branch is exercised without a real network.
type tailErrBody struct{}

func (tailErrBody) Read([]byte) (int, error) { return 0, errors.New("read exploded") }
func (tailErrBody) Close() error             { return nil }

// tailOKResponse wraps bytes into a 200 response.
func tailOKResponse(b []byte) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(b))}
}

// tailServeTarball answers the tarball URL with tgz and the ".sha256" URL with sum.
func tailServeTarball(tgz []byte, sum string) func(string) (*http.Response, error) {
	return func(url string) (*http.Response, error) {
		if strings.HasSuffix(url, ".sha256") {
			return tailOKResponse([]byte(sum + "  infracost.tar.gz")), nil
		}
		return tailOKResponse(tgz), nil
	}
}

// TestTail_EnsureBinaryCreatesCacheDirAndDownloads covers ensureBinary's "no cached binary" arm:
// it MkdirAlls the cache dir and delegates to download.
func TestTail_EnsureBinaryCreatesCacheDirAndDownloads(t *testing.T) {
	resetInfracostSeams(t)
	// A cache dir that does not exist yet, so MkdirAll actually runs.
	binaryCacheDir = filepath.Join(binaryCacheDir, "nested", "cache")

	tgz := tarGz(t, "dist/infracost", "binary")
	httpGet = tailServeTarball(tgz, fmt.Sprintf("%x", sha256.Sum256(tgz)))

	cli := NewInfracostCLI("v0.10.0", "token")
	if err := cli.ensureBinary(); err != nil {
		t.Fatalf("ensureBinary: %v", err)
	}
	want := filepath.Join(binaryCacheDir, "infracost_v0.10.0")
	if cli.binaryPath != want {
		t.Fatalf("binaryPath = %q, want %q", cli.binaryPath, want)
	}
}

// TestTail_EnsureBinaryReportsCacheDirFailure covers the MkdirAll error arm: a cache path that is
// occupied by a regular file can never become a directory.
func TestTail_EnsureBinaryReportsCacheDirFailure(t *testing.T) {
	resetInfracostSeams(t)
	blocker := filepath.Join(binaryCacheDir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	binaryCacheDir = filepath.Join(blocker, "cache")

	err := NewInfracostCLI("v0.10.0", "token").ensureBinary()
	if err == nil || !strings.Contains(err.Error(), "failed to create infracost cache directory") {
		t.Fatalf("ensureBinary error = %v, want the cache-directory failure", err)
	}
}

// TestTail_DownloadRejectsNonGzipBody covers the gzip.NewReader error arm — a checksum-matching
// body that is simply not a gzip stream.
func TestTail_DownloadRejectsNonGzipBody(t *testing.T) {
	resetInfracostSeams(t)
	body := []byte("this is not gzip")
	httpGet = tailServeTarball(body, fmt.Sprintf("%x", sha256.Sum256(body)))

	err := NewInfracostCLI("v0.10.0", "token").download(binaryCacheDir)
	if err == nil || !strings.Contains(err.Error(), "failed to create gzip reader") {
		t.Fatalf("download error = %v, want the gzip-reader failure", err)
	}
}

// TestTail_DownloadReportsTempFileFailure covers the os.CreateTemp error arm: a bin dir that
// does not exist.
func TestTail_DownloadReportsTempFileFailure(t *testing.T) {
	resetInfracostSeams(t)
	tgz := tarGz(t, "dist/infracost", "binary")
	httpGet = tailServeTarball(tgz, fmt.Sprintf("%x", sha256.Sum256(tgz)))

	err := NewInfracostCLI("v0.10.0", "token").download(filepath.Join(binaryCacheDir, "absent"))
	if err == nil || !strings.Contains(err.Error(), "failed to create temp file") {
		t.Fatalf("download error = %v, want the temp-file failure", err)
	}
}

// TestTail_DownloadRejectsArchiveWithoutBinary covers the tar walk running to io.EOF with no
// matching entry — the archive is refused rather than installing an empty file.
func TestTail_DownloadRejectsArchiveWithoutBinary(t *testing.T) {
	resetInfracostSeams(t)
	tgz := tarGz(t, "dist/README.md", "docs only")
	httpGet = tailServeTarball(tgz, fmt.Sprintf("%x", sha256.Sum256(tgz)))

	err := NewInfracostCLI("v0.10.0", "token").download(binaryCacheDir)
	if err == nil || !strings.Contains(err.Error(), "binary not found in the downloaded archive") {
		t.Fatalf("download error = %v, want the not-found-in-archive failure", err)
	}
}

// tailTruncatedTarGz builds a gzip stream carrying a tar header that declares more bytes than the
// stream actually holds — so tar.Reader.Next succeeds and the subsequent copy hits an unexpected
// EOF. `full` selects whether the header itself is truncated (Next fails) or its body is.
func tailTruncatedTarGz(t *testing.T, headerOnly bool) []byte {
	t.Helper()
	// Build a well-formed archive first, then cut the raw tar stream short.
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	full := tarGz(t, "dist/infracost", strings.Repeat("A", 4096))
	// Decompress the good archive to get the raw tar bytes.
	zr, err := gzip.NewReader(bytes.NewReader(full))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	tarBytes, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read tar: %v", err)
	}
	cut := 512 + 100 // header block plus a sliver of the 4096-byte body
	if headerOnly {
		cut = 300 // mid-header: tar.Reader.Next itself fails
	}
	if _, err := gz.Write(tarBytes[:cut]); err != nil {
		t.Fatalf("write gzip: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return raw.Bytes()
}

// TestTail_DownloadReportsTruncatedArchive covers both tar-read failure arms: a truncated header
// (tar.Reader.Next errors) and a truncated body (io.Copy errors mid-entry).
func TestTail_DownloadReportsTruncatedArchive(t *testing.T) {
	for _, tt := range []struct {
		name       string
		headerOnly bool
		want       string
	}{
		{"truncated header", true, "failed to read tar header"},
		{"truncated body", false, "failed to write infracost binary"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resetInfracostSeams(t)
			body := tailTruncatedTarGz(t, tt.headerOnly)
			httpGet = tailServeTarball(body, fmt.Sprintf("%x", sha256.Sum256(body)))

			err := NewInfracostCLI("v0.10.0", "token").download(binaryCacheDir)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("download error = %v, want %q", err, tt.want)
			}
		})
	}
}

// TestTail_DownloadReportsInstallFailure covers the atomic-rename error arm: the versioned
// destination is occupied by a NON-EMPTY directory, which no rename can replace.
func TestTail_DownloadReportsInstallFailure(t *testing.T) {
	resetInfracostSeams(t)
	dest := filepath.Join(binaryCacheDir, "infracost_v0.10.0")
	if err := os.MkdirAll(filepath.Join(dest, "occupied"), 0o755); err != nil {
		t.Fatal(err)
	}

	tgz := tarGz(t, "dist/infracost", "binary")
	httpGet = tailServeTarball(tgz, fmt.Sprintf("%x", sha256.Sum256(tgz)))

	err := NewInfracostCLI("v0.10.0", "token").download(binaryCacheDir)
	if err == nil || !strings.Contains(err.Error(), "failed to install infracost binary") {
		t.Fatalf("download error = %v, want the install (rename) failure", err)
	}
}

// TestTail_FetchBoundedReportsBodyReadFailure covers fetchBounded's io.ReadAll error arm.
func TestTail_FetchBoundedReportsBodyReadFailure(t *testing.T) {
	resetInfracostSeams(t)
	httpGet = func(string) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: tailErrBody{}}, nil
	}
	_, err := fetchBounded("https://example.invalid/x", "infracost")
	if err == nil || !strings.Contains(err.Error(), "failed to read infracost") {
		t.Fatalf("fetchBounded error = %v, want the body-read failure", err)
	}
}

// TestTail_ChecksumFetchAndEmptyFileFailClosed covers verifyInfracostChecksum's two remaining
// arms: the checksum asset itself being unfetchable, and an empty checksum file. Both must refuse
// the tarball rather than extract an unverified binary.
func TestTail_ChecksumFetchAndEmptyFileFailClosed(t *testing.T) {
	tgz := tarGz(t, "dist/infracost", "binary")

	t.Run("checksum asset missing", func(t *testing.T) {
		resetInfracostSeams(t)
		httpGet = func(url string) (*http.Response, error) {
			if strings.HasSuffix(url, ".sha256") {
				return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(""))}, nil
			}
			return tailOKResponse(tgz), nil
		}
		err := NewInfracostCLI("v0.10.0", "token").download(binaryCacheDir)
		if err == nil || !strings.Contains(err.Error(), "infracost checksum") {
			t.Fatalf("download error = %v, want the checksum-fetch failure", err)
		}
	})

	t.Run("checksum file empty", func(t *testing.T) {
		resetInfracostSeams(t)
		httpGet = func(url string) (*http.Response, error) {
			if strings.HasSuffix(url, ".sha256") {
				return tailOKResponse(nil), nil
			}
			return tailOKResponse(tgz), nil
		}
		err := NewInfracostCLI("v0.10.0", "token").download(binaryCacheDir)
		if err == nil || !strings.Contains(err.Error(), "checksum file was empty") {
			t.Fatalf("download error = %v, want the empty-checksum failure", err)
		}
	})
}

// TestTail_RunInfracostReportsBinaryFailure covers RunInfracost's ensureBinary error arm.
func TestTail_RunInfracostReportsBinaryFailure(t *testing.T) {
	resetInfracostSeams(t)
	httpGet = func(string) (*http.Response, error) { return nil, errors.New("no network") }
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		t.Fatal("RunInfracost ran a command without a binary")
		return nil
	}
	_, err := NewInfracostCLI("v0.10.0", "token").RunInfracost("plan.json", nil)
	if err == nil || !strings.Contains(err.Error(), "failed to ensure infracost binary") {
		t.Fatalf("RunInfracost error = %v, want the ensure-binary failure", err)
	}
}

// TestTail_RunInfracostReportsTempDirFailure covers the per-invocation MkdirTemp error arm by
// pointing TMPDIR at a path that cannot hold a directory.
func TestTail_RunInfracostReportsTempDirFailure(t *testing.T) {
	resetInfracostSeams(t)
	if err := os.WriteFile(filepath.Join(binaryCacheDir, "infracost_v0.10.0"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", filepath.Join(binaryCacheDir, "no-such-tmp"))

	_, err := NewInfracostCLI("v0.10.0", "token").RunInfracost("plan.json", nil)
	if err == nil || !strings.Contains(err.Error(), "failed to create temp directory") {
		t.Fatalf("RunInfracost error = %v, want the temp-directory failure", err)
	}
}

// TestTail_RunInfracostReportsMissingOutput covers the read-back arm: the command "succeeds" but
// writes no breakdown file, which must surface rather than parse an empty buffer.
func TestTail_RunInfracostReportsMissingOutput(t *testing.T) {
	resetInfracostSeams(t)
	if err := os.WriteFile(filepath.Join(binaryCacheDir, "infracost_v0.10.0"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return nil }

	_, err := NewInfracostCLI("v0.10.0", "token").RunInfracost("plan.json", nil)
	if err == nil || !strings.Contains(err.Error(), "failed to read infracost output") {
		t.Fatalf("RunInfracost error = %v, want the output-read failure", err)
	}
}
