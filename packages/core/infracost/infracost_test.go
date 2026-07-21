// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"archive/tar"
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

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

func resetInfracostSeams(t *testing.T) {
	t.Helper()
	origHTTPGet := httpGet
	origExecuteCommand := executeCommand
	origCacheDir := binaryCacheDir
	// Point the binary cache at a fresh temp dir per test so it's isolated (and not the shared
	// process cwd) — the #952 fix roots it in the OS temp dir.
	binaryCacheDir = t.TempDir()
	t.Cleanup(func() {
		httpGet = origHTTPGet
		executeCommand = origExecuteCommand
		binaryCacheDir = origCacheDir
	})
}

// writeBreakdownFromCmd simulates infracost writing its breakdown JSON: it extracts the
// (shell-quoted) --out-file path from the built command and writes content there. Robust to the
// per-invocation MkdirTemp path the #952 fix uses.
func writeBreakdownFromCmd(t *testing.T, command, content string) error {
	t.Helper()
	const marker = "--out-file "
	i := strings.Index(command, marker)
	if i < 0 {
		t.Fatalf("no --out-file in command %q", command)
	}
	rest := command[i+len(marker):]
	path := strings.Trim(strings.Fields(rest)[0], "'")
	return os.WriteFile(path, []byte(content), 0644)
}

func TestNewInfracostCLIAndCheckToken(t *testing.T) {
	cli := NewInfracostCLI("v0.10.0", "token")
	if cli.Version != "v0.10.0" {
		t.Fatalf("Version = %q, want v0.10.0", cli.Version)
	}
	if cli.apiKey != "token" {
		t.Fatalf("apiKey = %q, want token", cli.apiKey)
	}
	if !cli.CheckToken() {
		t.Fatal("CheckToken returned false for a configured API key")
	}

	if NewInfracostCLI("v0.10.0", "").CheckToken() {
		t.Fatal("CheckToken returned true for an empty API key")
	}
}

func TestEnsureBinaryUsesExistingVersionedBinary(t *testing.T) {
	resetInfracostSeams(t)

	version := "v0.10.0"
	wantPath := filepath.Join(binaryCacheDir, "infracost_"+version)
	if err := os.WriteFile(wantPath, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write binary: %v", err)
	}

	httpGet = func(string) (*http.Response, error) {
		t.Fatal("ensureBinary downloaded even though the versioned binary exists")
		return nil, nil
	}

	cli := NewInfracostCLI(version, "token")
	if err := cli.ensureBinary(); err != nil {
		t.Fatalf("ensureBinary: %v", err)
	}
	if cli.binaryPath != wantPath {
		t.Fatalf("binaryPath = %q, want %q", cli.binaryPath, wantPath)
	}
}

func TestDownloadExtractsBinaryAndRemovesArchive(t *testing.T) {
	resetInfracostSeams(t)
	t.Chdir(t.TempDir())

	tarball := tarGz(t, "dist/infracost", "binary")
	sum := fmt.Sprintf("%x", sha256.Sum256(tarball))
	httpGet = func(url string) (*http.Response, error) {
		if !strings.Contains(url, "/v0.10.0/") {
			t.Fatalf("download URL %q does not include requested version", url)
		}
		// The download now verifies the published per-asset checksum before extracting.
		if strings.HasSuffix(url, ".sha256") {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(sum + "  infracost.tar.gz"))}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(bytes.NewReader(tarball)),
		}, nil
	}

	cli := NewInfracostCLI("v0.10.0", "token")
	binDir := binaryCacheDir
	if err := cli.download(binDir); err != nil {
		t.Fatalf("download: %v", err)
	}

	// The binary is extracted to the VERSIONED cache path via an atomic rename (#952).
	wantPath := filepath.Join(binDir, "infracost_v0.10.0")
	if cli.binaryPath != wantPath {
		t.Fatalf("binaryPath = %q, want %q", cli.binaryPath, wantPath)
	}
	data, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("read extracted binary: %v", err)
	}
	if string(data) != "binary" {
		t.Fatalf("extracted binary = %q, want binary", data)
	}
	// No leftover temp download files remain in the cache dir.
	entries, err := os.ReadDir(binDir)
	if err != nil {
		t.Fatalf("read cache dir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "infracost-dl-") {
			t.Fatalf("leftover temp download file: %q", e.Name())
		}
	}
}

func TestDownloadReportsHTTPFailures(t *testing.T) {
	resetInfracostSeams(t)
	t.Chdir(t.TempDir())

	tests := []struct {
		name string
		get  func(string) (*http.Response, error)
		want string
	}{
		{
			name: "transport error",
			get: func(string) (*http.Response, error) {
				return nil, errors.New("network down")
			},
			want: "network down",
		},
		{
			name: "non ok status",
			get: func(string) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(""))}, nil
			},
			want: "status code 404",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			httpGet = tt.get
			err := NewInfracostCLI("v0.10.0", "token").download(t.TempDir())
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("download error = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func TestRunInfracostSkipsWithoutToken(t *testing.T) {
	resetInfracostSeams(t)

	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		t.Fatal("RunInfracost executed a command without an API key")
		return nil
	}

	got, err := NewInfracostCLI("v0.10.0", "").RunInfracost("plan.json", nil)
	if err != nil {
		t.Fatalf("RunInfracost: %v", err)
	}
	if got != nil {
		t.Fatalf("RunInfracost returned %#v, want nil when token is missing", got)
	}
}

func TestRunInfracostExecutesBreakdownAndParsesOutput(t *testing.T) {
	resetInfracostSeams(t)

	versionedBinary := filepath.Join(binaryCacheDir, "infracost_v0.10.0")
	if err := os.WriteFile(versionedBinary, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write binary: %v", err)
	}

	var gotCommand, gotDir string
	var gotEnv []string
	executeCommand = func(command string, dir string, env []string, _, _ io.Writer) error {
		gotCommand = command
		gotDir = dir
		gotEnv = append([]string(nil), env...)
		return writeBreakdownFromCmd(t, command, sampleBreakdown)
	}

	breakdown, err := NewInfracostCLI("v0.10.0", "token").RunInfracost("tfplan.json", []string{"A=B"})
	if err != nil {
		t.Fatalf("RunInfracost: %v", err)
	}
	if breakdown == nil || breakdown.Summary == nil {
		t.Fatal("RunInfracost returned no parsed summary")
	}
	if breakdown.Summary.TotalMonthly != 142.50 {
		t.Fatalf("TotalMonthly = %v, want 142.50", breakdown.Summary.TotalMonthly)
	}
	if gotDir != "." {
		t.Fatalf("command dir = %q, want .", gotDir)
	}
	if len(gotEnv) != 1 || gotEnv[0] != "A=B" {
		t.Fatalf("env = %#v, want [A=B]", gotEnv)
	}
	// Paths are shell-quoted to close the command-injection surface (#944); the breakdown output
	// now lands in a per-invocation temp dir (#952), so assert the basename rather than a fixed path.
	for _, want := range []string{utils.ShellQuote(versionedBinary), "breakdown", "--path 'tfplan.json'", "--format json", "infracost_breakdown.json"} {
		if !strings.Contains(gotCommand, want) {
			t.Fatalf("command %q does not contain %q", gotCommand, want)
		}
	}
}

// TestRunInfracostShellQuotesPlanPath asserts a plan path with shell metacharacters is
// single-quoted into the command string rather than interpreted by the shell (#944).
func TestRunInfracostShellQuotesPlanPath(t *testing.T) {
	resetInfracostSeams(t)

	versionedBinary := filepath.Join(binaryCacheDir, "infracost_v0.10.0")
	if err := os.WriteFile(versionedBinary, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write binary: %v", err)
	}

	var gotCommand string
	executeCommand = func(command string, _ string, _ []string, _, _ io.Writer) error {
		gotCommand = command
		return writeBreakdownFromCmd(t, command, sampleBreakdown)
	}

	// A malicious plan path: without quoting, `$(...)` would be command-substituted by bash.
	evil := "tfplan.json; $(touch /tmp/pwned)"
	if _, err := NewInfracostCLI("v0.10.0", "token").RunInfracost(evil, nil); err != nil {
		t.Fatalf("RunInfracost: %v", err)
	}
	if !strings.Contains(gotCommand, utils.ShellQuote(evil)) {
		t.Fatalf("plan path not shell-quoted in command %q", gotCommand)
	}
}

func TestRunInfracostPropagatesCommandAndParseErrors(t *testing.T) {
	resetInfracostSeams(t)

	if err := os.WriteFile(filepath.Join(binaryCacheDir, "infracost_v0.10.0"), []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write binary: %v", err)
	}

	t.Run("command failure", func(t *testing.T) {
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			return errors.New("boom")
		}
		_, err := NewInfracostCLI("v0.10.0", "token").RunInfracost("tfplan.json", nil)
		if err == nil || !strings.Contains(err.Error(), "infracost breakdown failed") {
			t.Fatalf("RunInfracost error = %v, want command failure", err)
		}
	})

	t.Run("invalid output", func(t *testing.T) {
		executeCommand = func(command string, _ string, _ []string, _, _ io.Writer) error {
			return writeBreakdownFromCmd(t, command, `{invalid`)
		}
		_, err := NewInfracostCLI("v0.10.0", "token").RunInfracost("tfplan.json", nil)
		if err == nil {
			t.Fatal("RunInfracost returned nil error for invalid JSON")
		}
	})
}

func tarGz(t *testing.T, name string, body string) []byte {
	t.Helper()

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{
		Name: name,
		Mode: 0755,
		Size: int64(len(body)),
	}); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatalf("write tar body: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buf.Bytes()
}
