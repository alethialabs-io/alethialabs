// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHTTPBackendWriteBackendHCL(t *testing.T) {
	dir := t.TempDir()
	// Trailing slash on ConsoleURL must be trimmed, not doubled.
	c := &HTTPBackendConfig{ConsoleURL: "https://console.example.com/", JobID: "job-1", Token: "super-secret-token"}

	path, err := c.WriteBackendHCL(dir)
	if err != nil {
		t.Fatalf("WriteBackendHCL: %v", err)
	}
	if want := filepath.Join(dir, "backend.hcl"); path != want {
		t.Fatalf("path = %q, want %q", path, want)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(b)

	for _, want := range []string{
		`address        = "https://console.example.com/api/jobs/job-1/state"`,
		`lock_address   = "https://console.example.com/api/jobs/job-1/state/lock"`,
		`unlock_address = "https://console.example.com/api/jobs/job-1/state/lock"`,
		`lock_method    = "POST"`,
		`unlock_method  = "DELETE"`,
	} {
		if !strings.Contains(content, want) {
			t.Errorf("backend.hcl missing %q\n--- got ---\n%s", want, content)
		}
	}

	// The whole point: no secret ever lands in the workdir file.
	for _, leak := range []string{"super-secret-token", "access_key", "secret_key", "TF_HTTP_PASSWORD"} {
		if strings.Contains(content, leak) {
			t.Errorf("backend.hcl leaked %q:\n%s", leak, content)
		}
	}

	if info, err := os.Stat(path); err == nil && info.Mode().Perm() != 0o600 {
		t.Errorf("backend.hcl perm = %o, want 600", info.Mode().Perm())
	}
}

func TestHTTPBackendSetAuthEnvSetsAndClears(t *testing.T) {
	os.Unsetenv("TF_HTTP_USERNAME")
	os.Unsetenv("TF_HTTP_PASSWORD")

	c := &HTTPBackendConfig{Token: "tok-123"}
	restore := c.SetAuthEnv()

	if got := os.Getenv("TF_HTTP_PASSWORD"); got != "tok-123" {
		t.Fatalf("TF_HTTP_PASSWORD = %q, want tok-123", got)
	}
	if got := os.Getenv("TF_HTTP_USERNAME"); got != "alethia" {
		t.Fatalf("TF_HTTP_USERNAME = %q, want alethia", got)
	}

	restore()
	if _, ok := os.LookupEnv("TF_HTTP_PASSWORD"); ok {
		t.Error("TF_HTTP_PASSWORD not cleared on restore")
	}
	if _, ok := os.LookupEnv("TF_HTTP_USERNAME"); ok {
		t.Error("TF_HTTP_USERNAME not cleared on restore")
	}
}

func TestHTTPBackendSetAuthEnvRestoresPrevious(t *testing.T) {
	os.Setenv("TF_HTTP_PASSWORD", "previous")
	t.Cleanup(func() { os.Unsetenv("TF_HTTP_PASSWORD") })

	c := &HTTPBackendConfig{Token: "override"}
	restore := c.SetAuthEnv()
	if got := os.Getenv("TF_HTTP_PASSWORD"); got != "override" {
		t.Fatalf("TF_HTTP_PASSWORD = %q, want override", got)
	}
	restore()
	if got := os.Getenv("TF_HTTP_PASSWORD"); got != "previous" {
		t.Fatalf("TF_HTTP_PASSWORD = %q, want previous restored", got)
	}
}
