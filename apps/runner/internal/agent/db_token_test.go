// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteTokenFile_AtomicAndMode0600(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := writeTokenFile(path, "tok-abc"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "tok-abc" {
		t.Errorf("token = %q, want tok-abc", string(b))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600 (a DB token must not be world-readable)", info.Mode().Perm())
	}

	// A second write replaces the token in place (rename over the existing file).
	if err := writeTokenFile(path, "tok-def"); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(path)
	if string(b) != "tok-def" {
		t.Errorf("token = %q, want tok-def after rewrite", string(b))
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("expected only the token file, got %d entries", len(entries))
	}
}

func TestRefreshAfter(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	// Well before expiry → lead-adjusted wait.
	if got := refreshAfter(now.Add(60*time.Minute), now); got != 55*time.Minute {
		t.Errorf("refreshAfter(60m) = %v, want 55m", got)
	}
	// Near/at expiry → floored, never negative/zero.
	if got := refreshAfter(now.Add(2*time.Minute), now); got != tokenRefreshFloor {
		t.Errorf("refreshAfter(2m) = %v, want floor %v", got, tokenRefreshFloor)
	}
	if got := refreshAfter(now.Add(-time.Hour), now); got != tokenRefreshFloor {
		t.Errorf("refreshAfter(expired) = %v, want floor %v", got, tokenRefreshFloor)
	}
}

func TestRunDBTokenLoop_OnceWritesAndReturns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	mint := func(context.Context) (string, time.Time, error) {
		return "minted-token", time.Now().Add(time.Hour), nil
	}
	if err := runDBTokenLoop(context.Background(), mint, path, true /*once*/); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "minted-token" {
		t.Fatalf("token file = %q err=%v, want minted-token", string(b), err)
	}
}

func TestRunDBToken_RejectsUnknownProviderAndMissingOut(t *testing.T) {
	if err := RunDBToken(context.Background(), []string{"--provider", "gcp", "--out", "/tmp/x"}); err == nil {
		t.Error("expected error for unsupported provider gcp")
	}
	if err := RunDBToken(context.Background(), []string{"--provider", "azure"}); err == nil {
		t.Error("expected error when --out is missing")
	}
}
