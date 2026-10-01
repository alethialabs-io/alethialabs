// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// ONE THROWAWAY RECEIPT KEY, SHARED BY THE RUNNER AND THE CI CONSOLE, FOR THE cli-demo DIMENSION.
//
// The `receipt-verify` beat runs `alethia verify receipt`. That command trusts a receipt only when
// its key_id matches a key the console vouches for: an org's recorded key, or the PLATFORM key.
// The console derives the platform key from its own ALETHIA_RECEIPT_SIGNING_KEY
// (apps/console/lib/evidence/platform-key.ts, served by /api/cli/signing-keys). The runner signs
// with ITS ALETHIA_RECEIPT_SIGNING_KEY (packages/core/verify SigningKeyFromEnv).
//
// Every other dimension signs with a key the spine generates in-process and verifies itself, and
// no console is involved. On cli-demo that key reached only the runner, and the CI console had no
// key, so it vouched for nothing. Every receipt was then reported UNTRUSTED, even though it was
// signed correctly (#5098).
//
// The console step starts BEFORE the spine runs, so the spine cannot hand its key over. The key is
// therefore made first, by a workflow step (cmd/clidemoreceiptkey → EmitCLIDemoReceiptKey). It goes
// into one 0600 file under $RUNNER_TEMP, and only the file PATH is exported. The console start step
// reads the file into its own environment, and the spine reads the same file for the runner
// (LoadCLIDemoReceiptKey). The key is never a repo secret, and it lives only for one job.
//
// This is test-harness wiring only. The product's trust rules are unchanged: the console still
// vouches only for the key it holds, and the CLI still trusts only what the console vouches for.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// CLIDemoReceiptKeyFileEnv names the file that holds the run's receipt key. The value is a PATH,
// never key material, so it is safe to put in $GITHUB_ENV and in a log line.
const CLIDemoReceiptKeyFileEnv = "ALETHIA_E2E_CLI_DEMO_RECEIPT_KEY_FILE"

// cliDemoReceiptKeyFileName is the basename the generator writes under its directory.
const cliDemoReceiptKeyFileName = "cli-demo-receipt-signing-key"

// WriteCLIDemoReceiptKey generates a fresh ed25519 key and writes it to a new 0600 file in dir, in
// the one format both sides read: base64(std) of the 64-byte seed||public private key. It returns
// the file's path and the encoded key. The caller masks the key and never prints it in the clear.
//
// It refuses to overwrite an existing file, so a re-run step cannot swap the key under a console
// that already holds the old one.
func WriteCLIDemoReceiptKey(dir string) (path, encoded string, err error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("generate ed25519 key: %w", err)
	}
	encoded = base64.StdEncoding.EncodeToString(priv)
	path = filepath.Join(dir, cliDemoReceiptKeyFileName)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", "", fmt.Errorf("create %s: %w", path, err)
	}
	if _, err := f.WriteString(encoded); err != nil {
		_ = f.Close()
		return "", "", fmt.Errorf("write %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return "", "", fmt.Errorf("close %s: %w", path, err)
	}
	return path, encoded, nil
}

// EmitCLIDemoReceiptKey is the workflow step's whole job (cmd/clidemoreceiptkey). It writes a fresh
// key file into dir, writes the `::add-mask::` command for the key to stdout, and appends
// CLIDemoReceiptKeyFileEnv=<path> to the githubEnv file. The mask goes out BEFORE the env line, so
// nothing that happens later in the job can print the key unmasked. stdout gets nothing else.
func EmitCLIDemoReceiptKey(dir, githubEnv string, stdout io.Writer) (path string, err error) {
	path, encoded, err := WriteCLIDemoReceiptKey(dir)
	if err != nil {
		return "", err
	}
	if _, err := fmt.Fprintf(stdout, "::add-mask::%s\n", encoded); err != nil {
		return "", fmt.Errorf("write the mask command: %w", err)
	}
	f, err := os.OpenFile(githubEnv, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", githubEnv, err)
	}
	if _, err := fmt.Fprintf(f, "%s=%s\n", CLIDemoReceiptKeyFileEnv, path); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("write %s: %w", githubEnv, err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("close %s: %w", githubEnv, err)
	}
	return path, nil
}

// LoadCLIDemoReceiptKey reads the run's receipt key from the file CLIDemoReceiptKeyFileEnv names.
// Errors never carry any part of the file's contents.
func LoadCLIDemoReceiptKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	path := strings.TrimSpace(os.Getenv(CLIDemoReceiptKeyFileEnv))
	if path == "" {
		return nil, nil, fmt.Errorf("%s is unset — the workflow's receipt-key step writes it. Without it the "+
			"runner would sign with a key the CI console does not hold, and `verify receipt` would "+
			"report every receipt as untrusted", CLIDemoReceiptKeyFileEnv)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("reading %s at %s: %w", CLIDemoReceiptKeyFileEnv, path, err)
	}
	return parseCLIDemoReceiptKey(raw)
}

// parseCLIDemoReceiptKey decodes and checks the key file's contents. It checks that the file's
// public half (bytes 32..64) is the key the seed really derives. The console reads that half as the
// platform key, and Go's ed25519.Sign hashes it into every signature. So a mismatched half would
// make every receipt fail verification, and nothing downstream would say why.
func parseCLIDemoReceiptKey(raw []byte) (ed25519.PublicKey, ed25519.PrivateKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, nil, fmt.Errorf("%s: the key file is not valid base64", CLIDemoReceiptKeyFileEnv)
	}
	if len(b) != ed25519.PrivateKeySize {
		return nil, nil, fmt.Errorf("%s: expected a %d-byte ed25519 private key, got %d bytes",
			CLIDemoReceiptKeyFileEnv, ed25519.PrivateKeySize, len(b))
	}
	priv := ed25519.PrivateKey(b)
	derived := ed25519.NewKeyFromSeed(priv.Seed())
	if !bytes.Equal(derived, priv) {
		return nil, nil, fmt.Errorf("%s: the key file's public half is not the key its seed derives", CLIDemoReceiptKeyFileEnv)
	}
	pub, _ := derived.Public().(ed25519.PublicKey)
	return pub, priv, nil
}

// ResolveT2ReceiptKey returns the receipt-signing key the spine gives its runner. On the cli-demo
// dimension this is the run's shared key, so the console that `verify receipt` asks holds the same
// key. On every other dimension it is a fresh in-process key, as before. source says which one it
// is, for the log.
func ResolveT2ReceiptKey(cliDemo bool) (pub ed25519.PublicKey, priv ed25519.PrivateKey, source string, err error) {
	if cliDemo {
		pub, priv, err = LoadCLIDemoReceiptKey()
		return pub, priv, "the run's shared cli-demo key (" + CLIDemoReceiptKeyFileEnv + ")", err
	}
	pub, priv, err = ed25519.GenerateKey(rand.Reader)
	return pub, priv, "an in-process key", err
}
