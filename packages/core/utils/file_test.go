// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package utils

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteSecretFileIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret.tfvars")
	if err := WriteSecretFile(path, []byte("token = \"s3cr3t\"")); err != nil {
		t.Fatalf("WriteSecretFile: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != SecretFileMode {
		t.Fatalf("mode = %o, want %o (owner read/write only)", got, SecretFileMode)
	}
	// Guard the constant itself: no group/world bits.
	if SecretFileMode&0o077 != 0 {
		t.Fatalf("SecretFileMode %o grants group/world access", SecretFileMode)
	}

	data, err := os.ReadFile(path)
	if err != nil || string(data) != "token = \"s3cr3t\"" {
		t.Fatalf("content round-trip: data=%q err=%v", data, err)
	}
}

func TestWriteSecretFileReportsErrors(t *testing.T) {
	// A path whose parent doesn't exist must surface an error, not silently drop the secret.
	if err := WriteSecretFile(filepath.Join(t.TempDir(), "nope", "x"), []byte("x")); err == nil {
		t.Fatal("expected an error writing under a missing directory")
	}
}
