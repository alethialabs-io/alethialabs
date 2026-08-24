// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubVaultKubectl installs a recording `kubectl` on PATH for one test. `get` answers with getBody (or
// exits 1 when empty, standing in for an absent Secret); everything else succeeds.
func stubVaultKubectl(t *testing.T, getBody string) *string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	body := filepath.Join(dir, "body")
	if err := os.WriteFile(body, []byte(getBody), 0o600); err != nil {
		t.Fatalf("write body: %v", err)
	}
	// The applied manifest is copied out so a test can read what was written WITHOUT the value ever
	// appearing in the recorded argv — which is the property being asserted.
	applied := filepath.Join(dir, "applied.yaml")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + log + "\n" +
		"case \"$1\" in\n" +
		"  get) if [ -s " + body + " ]; then cat " + body + "; exit 0; else exit 1; fi;;\n" +
		"  apply) cp \"$3\" " + applied + "; exit 0;;\n" +
		"esac\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &applied
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

// A missing Secret is the FIRST RUN, not a failure. Getting this wrong in either direction is
// severe: reporting an error fails every fresh cluster, and reporting data that is not there would
// let the bootstrap think a Vault is already initialised.
func TestKubeSecretStoreReadTreatsAMissingSecretAsEmpty(t *testing.T) {
	stubVaultKubectl(t, "") // `get` exits 1
	got, err := (&kubeSecretStore{namespace: "vault", name: "alethia-vault-state"}).Read(context.Background())
	if err != nil {
		t.Fatalf("a missing Secret was reported as an error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("read %v from a missing Secret", got)
	}
}

func TestKubeSecretStoreReadDecodesTheStoredFields(t *testing.T) {
	body := `{"data":{"unsealKey":"` + base64.StdEncoding.EncodeToString([]byte("k-1")) +
		`","initialized":"` + base64.StdEncoding.EncodeToString([]byte("true")) + `"}}`
	stubVaultKubectl(t, body)

	got, err := (&kubeSecretStore{namespace: "vault", name: "alethia-vault-state"}).Read(context.Background())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got[vaultUnsealKeyField] != "k-1" || got[vaultInitializedField] != "true" {
		t.Errorf("read %v, want the decoded unseal key and marker", got)
	}
}

// A Secret we cannot PARSE is not an empty one. Returning empty here would let the bootstrap
// re-initialise a live Vault and discard every secret in it.
func TestKubeSecretStoreReadFailsOnAnUndecodableSecret(t *testing.T) {
	stubVaultKubectl(t, `{"data":{"unsealKey":"!!!not-base64!!!"}}`)
	if _, err := (&kubeSecretStore{namespace: "vault", name: "s"}).Read(context.Background()); err == nil {
		t.Error("an undecodable Secret was reported as empty — that would re-initialise a live Vault")
	}
	stubVaultKubectl(t, `not json at all`)
	if _, err := (&kubeSecretStore{namespace: "vault", name: "s"}).Read(context.Background()); err == nil {
		t.Error("unparseable JSON was reported as empty")
	}
}

// THE property that matters most in this file: the unseal key must never reach argv. argv is
// world-readable through /proc, so `kubectl create secret --from-literal=key=<unseal key>` would
// publish it to every process on the node.
func TestWriteOpaqueSecretKeepsValuesOutOfArgv(t *testing.T) {
	applied := stubVaultKubectl(t, "")
	const secretValue = "s3cr3t-unseal-key-value"

	if err := writeOpaqueSecret(context.Background(), "vault", "alethia-vault-state",
		map[string]string{vaultUnsealKeyField: secretValue}); err != nil {
		t.Fatalf("writeOpaqueSecret: %v", err)
	}

	// The recorded argv is `apply -f <path>` — the value is in the FILE, base64-encoded.
	body := readFile(t, *applied)
	if body == "" {
		t.Fatal("nothing was applied")
	}
	if strings.Contains(body, secretValue) {
		t.Error("the value appears in plaintext in the applied manifest")
	}
	if !strings.Contains(body, base64.StdEncoding.EncodeToString([]byte(secretValue))) {
		t.Errorf("the value was not base64-encoded into the Secret:\n%s", body)
	}
	if !strings.Contains(body, "kind: Secret") || !strings.Contains(body, "type: Opaque") {
		t.Errorf("the applied document is not an Opaque Secret:\n%s", body)
	}
}

// An empty value would produce a Secret that authenticates nothing, and the failure would surface
// far from here — as ESO quietly resolving nothing.
func TestWriteOpaqueSecretRefusesEmptyInput(t *testing.T) {
	stubVaultKubectl(t, "")
	ctx := context.Background()
	if err := writeOpaqueSecret(ctx, "", "s", map[string]string{"k": "v"}); err == nil {
		t.Error("wrote a Secret with no namespace")
	}
	if err := writeOpaqueSecret(ctx, "vault", "", map[string]string{"k": "v"}); err == nil {
		t.Error("wrote a Secret with no name")
	}
	if err := writeOpaqueSecret(ctx, "vault", "s", map[string]string{"k": ""}); err == nil {
		t.Error("wrote an empty value")
	}
}

// Sorted keys keep a re-apply of unchanged data byte-identical, so kubectl reports no change and the
// job log stays readable across deploys.
func TestWriteOpaqueSecretIsByteStableAcrossRuns(t *testing.T) {
	data := map[string]string{"zeta": "1", "alpha": "2", "mid": "3"}
	applied := stubVaultKubectl(t, "")
	if err := writeOpaqueSecret(context.Background(), "vault", "s", data); err != nil {
		t.Fatalf("writeOpaqueSecret: %v", err)
	}
	first := readFile(t, *applied)

	applied2 := stubVaultKubectl(t, "")
	if err := writeOpaqueSecret(context.Background(), "vault", "s", data); err != nil {
		t.Fatalf("writeOpaqueSecret: %v", err)
	}
	if second := readFile(t, *applied2); first != second {
		t.Errorf("two writes of identical data differ:\n%s\n---\n%s", first, second)
	}
	if i, j := strings.Index(first, "alpha"), strings.Index(first, "zeta"); i > j {
		t.Error("keys are not sorted, so an unchanged re-apply would look like a change")
	}
}

func TestWriteOpaqueSecretReportsAKubectlFailure(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := writeOpaqueSecret(context.Background(), "vault", "s", map[string]string{"k": "v"}); err == nil {
		t.Error("a failed apply was reported as success")
	}
}

func TestRandomTokenIsUniqueAndLongEnough(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		tok, err := randomToken(32)
		if err != nil {
			t.Fatalf("randomToken: %v", err)
		}
		if len(tok) < 32 {
			t.Fatalf("token is only %d chars", len(tok))
		}
		if seen[tok] {
			t.Fatal("randomToken repeated a value")
		}
		seen[tok] = true
	}
}
