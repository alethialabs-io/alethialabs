// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// stubKubectlOutcome puts a `kubectl` on PATH that prints `stdout` / `stderr` and exits with
// `code`.
//
// It exists alongside stubVaultKubectl because that one always succeeds, and the whole defect here
// was in the FAILURE branch: every non-zero exit was being reported as an absent Secret. A stub
// that cannot fail cannot show that. Real exec, not a fake at the interface — the bug lived in how
// the process's exit status was read, which an interface fake would step over.
func stubKubectlOutcome(t *testing.T, stdout, stderr string, code int) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake kubectl is a shell script")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\n" +
		"printf '%s' " + strconv.Quote(stdout) + "\n" +
		"printf '%s' " + strconv.Quote(stderr) + " >&2\n" +
		"exit " + strconv.Itoa(code) + "\n"
	path := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// THE BUG. Every non-zero exit used to be reported as "absent", which is the one answer that turns
// off the data-loss guard in vaultBootstrap.
func TestKubeSecretStoreReadForbiddenIsAnErrorNotAnEmptySecret(t *testing.T) {
	stubKubectlOutcome(t, "", `Error from server (Forbidden): secrets "state" is forbidden: User "system:serviceaccount:vault:alethia-bootstrap-vault" cannot get resource "secrets"`, 1)

	got, err := (&kubeSecretStore{namespace: "vault", name: "state"}).Read(context.Background())
	if err == nil {
		t.Fatalf("a read that could not be performed was reported as an absent Secret: %v", got)
	}
	if got != nil {
		t.Errorf("no data may be returned alongside the error: %v", got)
	}
	// The message has to carry kubectl's own words, or the operator gets "exit status 1" for an
	// RBAC problem the API server described in full.
	if !strings.Contains(err.Error(), "Forbidden") {
		t.Errorf("kubectl's stderr was dropped: %v", err)
	}
	if !strings.Contains(err.Error(), "vault/state") {
		t.Errorf("the error does not name the Secret: %v", err)
	}
}

// A warning on stderr is the ordinary shape of authenticating to a managed cluster, and it must not
// turn a successful read into a failure — nor be folded into the value.
func TestKubeSecretStoreReadIgnoresStderrOnASuccessfulRead(t *testing.T) {
	stubKubectlOutcome(t, `{"data":{"unseal-key":"a2V5LW1hdGVyaWFs"}}`, "Warning: v1 Secret is deprecated in this fantasy\n", 0)
	got, err := (&kubeSecretStore{namespace: "vault", name: "state"}).Read(context.Background())
	if err != nil {
		t.Fatalf("a warning on a successful call is not a failure: %v", err)
	}
	if got["unseal-key"] != "key-material" {
		t.Errorf("the warning poisoned the value: %q", got["unseal-key"])
	}
}
