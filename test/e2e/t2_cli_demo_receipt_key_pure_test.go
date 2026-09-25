// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// On the cli-demo path, the key the RUNNER signs with must be the key the CI CONSOLE vouches for as
// its platform key. If it is not, `alethia verify receipt` reports every receipt as untrusted
// (#5098). Both halves are read from what really runs, not restated:
//
//   - The generator is EmitCLIDemoReceiptKey, the whole body of the workflow's key step.
//   - The runner side is ResolveT2ReceiptKey(cliDemo=true), the call t2_provision_test.go makes. Its
//     result goes through the runner's own env line into verify.SigningKeyFromEnv, the loader the
//     runner signs with.
//   - The console side EXECUTES the workflow's console start step, every line before
//     `next start`, and reads ALETHIA_RECEIPT_SIGNING_KEY from a child process. That is what
//     `next start` would inherit.
//
// Stated boundary: the console's derivation (apps/console/lib/evidence/platform-key.ts) is TypeScript,
// so consolePlatformKey below restates it: public = bytes 32..64, key_id = hex(sha256(pub))[:16].
// That file's own vitest pins the TS side to the same arithmetic. This test pins that the TS reads the
// same env var name that this side exports.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"gopkg.in/yaml.v3"
)

// consolePlatformKey restates platformSigningKey() from apps/console/lib/evidence/platform-key.ts:
// the value is trimmed and base64-decoded, it must be 64 bytes, the public key is bytes 32..64, and
// keyId is hex(sha256(pub))[:16]. ok=false is the console's null, meaning it vouches for no key.
func consolePlatformKey(envValue string) (pub []byte, keyID string, ok bool) {
	raw := strings.TrimSpace(envValue)
	if raw == "" {
		return nil, "", false
	}
	b, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(b) != 64 {
		return nil, "", false
	}
	pub = b[32:64]
	sum := sha256.Sum256(pub)
	return pub, hex.EncodeToString(sum[:])[:16], true
}

// cliDemoWorkflowSteps returns the steps of the e2e-nightly job that runs the cli-demo console,
// with the indexes of the three steps this contract spans.
func cliDemoWorkflowSteps(t *testing.T) (steps []ghStep, keyIdx, consoleIdx, t2Idx int) {
	t.Helper()
	path := filepath.Join(e2ePackageDir(t), "..", "..", ".github", "workflows", "e2e-nightly.yml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var wf ghWorkflow
	if err := yaml.Unmarshal(raw, &wf); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	for _, job := range wf.Jobs {
		keyIdx, consoleIdx, t2Idx = -1, -1, -1
		for i, s := range job.Steps {
			switch {
			case strings.Contains(s.Run, "./cmd/clidemoreceiptkey"):
				keyIdx = i
			case strings.Contains(s.Run, "exec next start"):
				consoleIdx = i
			case s.ID == "t2":
				t2Idx = i
			}
		}
		if consoleIdx >= 0 {
			return job.Steps, keyIdx, consoleIdx, t2Idx
		}
	}
	t.Fatalf("no job in %s starts the console with `next start` — this contract read nothing", path)
	return nil, -1, -1, -1
}

// runConsoleStepPrefix executes the console start step up to (not including) its `next start` line,
// with the step's env plus extra, and returns ALETHIA_RECEIPT_SIGNING_KEY as a CHILD process sees it.
func runConsoleStepPrefix(t *testing.T, step ghStep, extra map[string]string) string {
	t.Helper()
	lines := strings.Split(step.Run, "\n")
	cut := -1
	for i, l := range lines {
		if strings.Contains(l, "exec next start") {
			cut = i
			break
		}
	}
	if cut < 0 {
		t.Fatal("the console step has no `next start` line")
	}
	out := filepath.Join(t.TempDir(), "console-env")
	script := strings.Join(lines[:cut], "\n") +
		"\nbash -c 'printf %s \"${" + verify.SigningKeyEnv + ":-}\"' > \"$__OUT\"\n"
	cmd := exec.Command("bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "__OUT=" + out}
	for k, v := range step.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	for k, v := range extra {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var stderr bytes.Buffer
	cmd.Stdout = &stderr
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("the console step's prefix failed: %v\n%s", err, stderr.String())
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read the console env probe: %v", err)
	}
	return string(got)
}

// readGithubEnv parses a $GITHUB_ENV file of NAME=value lines.
func readGithubEnv(t *testing.T, path string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read GITHUB_ENV: %v", err)
	}
	m := map[string]string{}
	for _, l := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if k, v, ok := strings.Cut(l, "="); ok {
			m[k] = v
		}
	}
	return m
}

// TestCLIDemoRunnerKeyIsTheConsolePlatformKey is the contract: the key step runs, then the console
// step, then the spine. The runner's public key and key_id must equal the console's platform key,
// and a receipt the runner signs must verify under the key the console vouches for.
func TestCLIDemoRunnerKeyIsTheConsolePlatformKey(t *testing.T) {
	steps, keyIdx, consoleIdx, t2Idx := cliDemoWorkflowSteps(t)
	if keyIdx < 0 || t2Idx < 0 {
		t.Fatalf("the cli-demo job is missing a step: key=%d console=%d t2=%d", keyIdx, consoleIdx, t2Idx)
	}
	if !(keyIdx < consoleIdx && consoleIdx < t2Idx) {
		t.Fatalf("step order key=%d console=%d t2=%d: the key must exist before the console starts and before the spine runs", keyIdx, consoleIdx, t2Idx)
	}
	if strings.Contains(steps[keyIdx].Run, ">>") {
		t.Fatal("the key step redirects stdout: its stdout is the ::add-mask:: line, which carries the key; it must never land in $GITHUB_ENV")
	}

	// 1. The workflow's key step.
	dir := t.TempDir()
	ghEnv := filepath.Join(dir, "github-env")
	var stdout bytes.Buffer
	keyPath, err := EmitCLIDemoReceiptKey(dir, ghEnv, &stdout)
	if err != nil {
		t.Fatalf("EmitCLIDemoReceiptKey: %v", err)
	}
	fileBytes, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := stdout.String(), "::add-mask::"+string(fileBytes)+"\n"; got != want {
		t.Fatal("the key step's stdout must be exactly the ::add-mask:: command for the key, and nothing else")
	}
	if fi, err := os.Stat(keyPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("the key file must be 0600: %v %v", fi.Mode().Perm(), err)
	}
	exported := readGithubEnv(t, ghEnv)
	if len(exported) != 1 || exported[CLIDemoReceiptKeyFileEnv] != keyPath {
		t.Fatalf("GITHUB_ENV must carry only %s=<path>, got %d entries", CLIDemoReceiptKeyFileEnv, len(exported))
	}
	if bytes.Contains(mustRead(t, ghEnv), fileBytes) {
		t.Fatal("GITHUB_ENV carries the key material itself")
	}

	// 2. The console step, as it runs.
	consoleEnv := runConsoleStepPrefix(t, steps[consoleIdx], exported)
	consolePub, consoleKeyID, ok := consolePlatformKey(consoleEnv)
	if !ok {
		t.Fatal("the console step exports no usable " + verify.SigningKeyEnv + " — it would vouch for no platform key")
	}

	// 3. The spine, on the cli-demo path, into the runner's own loader.
	for k, v := range exported {
		t.Setenv(k, v)
	}
	_, priv, _, err := ResolveT2ReceiptKey(true)
	if err != nil {
		t.Fatalf("ResolveT2ReceiptKey(cli-demo): %v", err)
	}
	t.Setenv(verify.SigningKeyEnv, base64.StdEncoding.EncodeToString(priv)) // the runner's env line
	runnerPriv, runnerKeyID, signs, err := verify.SigningKeyFromEnv()
	if err != nil || !signs {
		t.Fatalf("the runner would not sign: ok=%v err=%v", signs, err)
	}
	runnerPub, _ := runnerPriv.Public().(ed25519.PublicKey)

	if !bytes.Equal(runnerPub, consolePub) {
		t.Fatal("the runner's public key is not the console's platform key — verify receipt would report every receipt as untrusted")
	}
	if runnerKeyID != consoleKeyID {
		t.Fatalf("runner key_id %s != console platform key_id %s", runnerKeyID, consoleKeyID)
	}
	msg := []byte("a receipt the runner signs")
	if !ed25519.Verify(ed25519.PublicKey(consolePub), msg, ed25519.Sign(runnerPriv, msg)) {
		t.Fatal("a signature by the runner's key does not verify under the console's platform key")
	}
}

// TestCLIDemoReceiptKeyContractCanFail is the mutation control. The pre-#5098 spine, which made a
// fresh in-process key on every path, must NOT match the console. A key file whose public half
// was tampered with must be refused. A missing file variable must be refused rather than
// silently falling back to an in-process key.
func TestCLIDemoReceiptKeyContractCanFail(t *testing.T) {
	dir := t.TempDir()
	path, _, err := WriteCLIDemoReceiptKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	consolePub, _, ok := consolePlatformKey(string(mustRead(t, path)))
	if !ok {
		t.Fatal("the console refused a freshly written key")
	}
	inProcPub, _, _, err := ResolveT2ReceiptKey(false)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(inProcPub, consolePub) {
		t.Fatal("an in-process key matched the console's: the contract cannot tell the bug from the fix")
	}

	b, _ := base64.StdEncoding.DecodeString(string(mustRead(t, path)))
	b[40] ^= 0xff
	if _, _, err := parseCLIDemoReceiptKey([]byte(base64.StdEncoding.EncodeToString(b))); err == nil {
		t.Fatal("a key file whose public half is not its seed's was accepted")
	}
	if _, _, err := parseCLIDemoReceiptKey([]byte("c2hvcnQ=")); err == nil {
		t.Fatal("a short key was accepted")
	}

	t.Setenv(CLIDemoReceiptKeyFileEnv, "")
	if _, _, _, err := ResolveT2ReceiptKey(true); err == nil {
		t.Fatal("cli-demo with no key file resolved a key — the runner would sign with one the console does not hold")
	}

	if _, _, err := WriteCLIDemoReceiptKey(dir); err == nil {
		t.Fatal("a second write replaced the key file under a console that already holds the first")
	}
}

// TestConsoleReadsTheEnvVarTheHarnessExports checks the one fact consolePlatformKey cannot restate:
// the console reads the SAME variable name the workflow exports and the runner signs from.
func TestConsoleReadsTheEnvVarTheHarnessExports(t *testing.T) {
	src := filepath.Join(e2ePackageDir(t), "..", "..", "apps", "console", "lib", "evidence", "platform-key.ts")
	if !strings.Contains(string(mustRead(t, src)), `const SIGNING_KEY_ENV = "`+verify.SigningKeyEnv+`"`) {
		t.Fatalf("%s no longer reads %s — the workflow's export would reach a variable the console ignores", src, verify.SigningKeyEnv)
	}
}

// mustRead reads a file or fails the test.
func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return b
}
