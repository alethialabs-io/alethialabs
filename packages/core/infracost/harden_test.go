// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestResolvedInfracostVersion(t *testing.T) {
	t.Run("defaults when unset", func(t *testing.T) {
		t.Setenv(InfracostVersionEnv, "")
		if got := ResolvedInfracostVersion(); got != DefaultInfracostVersion {
			t.Fatalf("got %q, want default %q", got, DefaultInfracostVersion)
		}
	})
	t.Run("honors the override", func(t *testing.T) {
		t.Setenv(InfracostVersionEnv, "v0.11.0")
		if got := ResolvedInfracostVersion(); got != "v0.11.0" {
			t.Fatalf("got %q, want v0.11.0", got)
		}
	})
	t.Run("trims whitespace", func(t *testing.T) {
		t.Setenv(InfracostVersionEnv, "  v0.12.0\n")
		if got := ResolvedInfracostVersion(); got != "v0.12.0" {
			t.Fatalf("got %q, want v0.12.0", got)
		}
	})
}

// The supply-chain regression for #946: a tarball whose published checksum doesn't match must be
// rejected before the binary is ever extracted or executed.
func TestDownloadRejectsChecksumMismatch(t *testing.T) {
	resetInfracostSeams(t)
	tarball := tarGz(t, "dist/infracost", "binary")
	httpGet = func(url string) (*http.Response, error) {
		if strings.HasSuffix(url, ".sha256") {
			// A checksum that does NOT match the tarball.
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(strings.Repeat("0", 64)))}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(tarball))}, nil
	}

	binDir := t.TempDir()
	err := NewInfracostCLI("v0.10.0", "token").download(binDir)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("download err = %v, want a checksum mismatch", err)
	}
	// The binary must NOT have been written on a checksum failure.
	if _, statErr := os.Stat(binDir + "/infracost"); statErr == nil {
		t.Fatal("infracost binary was written despite a checksum mismatch")
	}
}
