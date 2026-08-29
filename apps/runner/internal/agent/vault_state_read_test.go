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
// `code`, and records the argv it was called with.
//
// It exists alongside stubVaultKubectl because that one always succeeds, and the whole defect here
// was in the FAILURE branch: every non-zero exit was being reported as an absent Secret. A stub
// that cannot fail cannot show that. Real exec, not a fake at the interface — the bug lived in how
// the process's exit status was read, which an interface fake would step over.
//
// The payloads go through FILES rather than into the script text. Splicing a Go-quoted string into
// a shell word gets it wrong twice: `\n` stays two literal characters, so a "multi-line stderr"
// fixture is nothing of the kind, and a `$` or a backtick in the payload would be expanded or
// executed by the stub instead of printed by it.
func stubKubectlOutcome(t *testing.T, stdout, stderr string, code int) (argvPath string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub kubectl is a shell script")
	}
	dir := t.TempDir()
	outFile := filepath.Join(dir, "stdout")
	errFile := filepath.Join(dir, "stderr")
	argv := filepath.Join(dir, "argv")
	for path, content := range map[string]string{outFile: stdout, errFile: stderr} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + argv + "\n" +
		"cat " + outFile + "\n" +
		"cat " + errFile + " >&2\n" +
		"exit " + strconv.Itoa(code) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return argv
}

// THE BUG. Every non-zero exit used to be reported as "absent", which is the one answer that turns
// off the data-loss guard in vaultBootstrap.
func TestKubeSecretStoreReadForbiddenIsAnErrorNotAnEmptySecret(t *testing.T) {
	stubKubectlOutcome(t, "", `Error from server (Forbidden): secrets is forbidden: User "system:serviceaccount:vault:alethia-bootstrap-vault" cannot list resource "secrets"`, 1)

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

// A failure with nothing on stderr — kubectl not on PATH, killed by the context — must not produce
// a message ending in a bare colon, which reads like one that got cut off.
func TestKubeSecretStoreReadErrorWithNoStderrHasNoDanglingColon(t *testing.T) {
	stubKubectlOutcome(t, "", "", 1)
	_, err := (&kubeSecretStore{namespace: "vault", name: "state"}).Read(context.Background())
	if err == nil {
		t.Fatal("want an error")
	}
	if strings.HasSuffix(strings.TrimSpace(err.Error()), ":") {
		t.Errorf("the message ends in a bare colon: %q", err)
	}
}

// ABSENCE IS PROVEN. The read lists with a field selector, so the API server answering `items: []`
// is a positive statement that it looked — not an error this code chose to interpret.
func TestKubeSecretStoreReadAsksForAbsenceItCanProve(t *testing.T) {
	argv := stubKubectlOutcome(t, `{"items":[]}`, "", 0)
	got, err := (&kubeSecretStore{namespace: "vault", name: "alethia-vault-state"}).Read(context.Background())
	if err != nil {
		t.Fatalf("an empty list is the first run, not a failure: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("want an empty map, got %v", got)
	}
	// PIN THE ARGV. The stub exits 0 whatever flags it is given, so losing the selector leaves this
	// suite green while every fresh cluster hard-fails bootstrap through all four retries.
	calls := readFile(t, argv)
	if !strings.Contains(calls, "--field-selector metadata.name=alethia-vault-state") {
		t.Errorf("the read is not proving absence by field selector: %s", calls)
	}
	if strings.Contains(calls, "--ignore-not-found") {
		t.Errorf("--ignore-not-found is back: it suppresses ANY 404, including a proxy's: %s", calls)
	}
}

// THE THIRD STATE. A Secret that exists carrying nothing we recognise returns byte-for-byte the
// absent answer, so the guard would not fire and a bootstrap could re-initialise a Vault this
// cluster may still hold the key for — under renamed keys, or after someone emptied the object.
func TestKubeSecretStoreReadRefusesAPresentButUnrecognisableSecret(t *testing.T) {
	stubKubectlOutcome(t, `{"items":[{"data":{"someOtherKey":"eA=="}}]}`, "", 0)
	got, err := (&kubeSecretStore{namespace: "vault", name: "state"}).Read(context.Background())
	if err == nil {
		t.Fatalf("a present-but-unrecognisable state Secret was read as a first run: %v", got)
	}
	if !strings.Contains(err.Error(), "exists but carries neither") {
		t.Errorf("the error does not say what is wrong: %v", err)
	}
}

// And the ordinary present case still decodes.
func TestKubeSecretStoreReadDecodesAPresentSecretFromTheList(t *testing.T) {
	// base64("key-material") = a2V5LW1hdGVyaWFs
	stubKubectlOutcome(t, `{"items":[{"data":{"unsealKey":"a2V5LW1hdGVyaWFs"}}]}`, "", 0)
	got, err := (&kubeSecretStore{namespace: "vault", name: "state"}).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got[vaultUnsealKeyField] != "key-material" {
		t.Errorf("decoded %q, want key-material", got[vaultUnsealKeyField])
	}
}

// A warning on stderr is the ordinary shape of authenticating to a managed cluster, and it must not
// turn a successful read into a failure — nor be folded into the value. Written through a file, so
// the newline in it is a real newline.
func TestKubeSecretStoreReadIgnoresStderrOnASuccessfulRead(t *testing.T) {
	stubKubectlOutcome(t, `{"items":[{"data":{"unsealKey":"a2V5LW1hdGVyaWFs"}}]}`,
		"Warning: v1 Secret is deprecated in this fantasy\nWarning: and again\n", 0)
	got, err := (&kubeSecretStore{namespace: "vault", name: "state"}).Read(context.Background())
	if err != nil {
		t.Fatalf("a warning on a successful call is not a failure: %v", err)
	}
	if got[vaultUnsealKeyField] != "key-material" {
		t.Errorf("the warning poisoned the value: %q", got[vaultUnsealKeyField])
	}
}
