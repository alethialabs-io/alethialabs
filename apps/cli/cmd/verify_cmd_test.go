// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/spf13/cobra"
)

// --- the flag resolvers ---------------------------------------------------------------------

func TestCurrentJob(t *testing.T) {
	cmd := &cobra.Command{}
	cmd.Flags().StringP("job", "j", "", "")

	if _, err := currentJob(cmd); err == nil || !strings.Contains(err.Error(), "--job is required") {
		t.Errorf("an absent --job must be a named error, got %v", err)
	}
	if err := cmd.Flags().Set("job", "job-7"); err != nil {
		t.Fatal(err)
	}
	got, err := currentJob(cmd)
	if err != nil || got != "job-7" {
		t.Errorf("want job-7, got (%q, %v)", got, err)
	}
}

func TestVerifyOptsFrom(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b64 := base64.StdEncoding.EncodeToString(pub)

	newCmd := func() *cobra.Command {
		c := &cobra.Command{}
		c.Flags().String("key", "", "")
		c.Flags().String("key-file", "", "")
		c.Flags().Bool("allow-unsigned", false, "")
		c.Flags().Bool("allow-untrusted", false, "")
		return c
	}

	t.Run("defaults", func(t *testing.T) {
		opts, err := verifyOptsFrom(newCmd())
		if err != nil {
			t.Fatalf("verifyOptsFrom: %v", err)
		}
		if opts.pinned != nil || opts.allowUnsigned || opts.allowUntrusted {
			t.Errorf("want a zero policy, got %+v", opts)
		}
	})

	t.Run("every flag set", func(t *testing.T) {
		c := newCmd()
		for k, v := range map[string]string{"key": b64, "allow-unsigned": "true", "allow-untrusted": "true"} {
			if err := c.Flags().Set(k, v); err != nil {
				t.Fatal(err)
			}
		}
		opts, err := verifyOptsFrom(c)
		if err != nil {
			t.Fatalf("verifyOptsFrom: %v", err)
		}
		if opts.pinned == nil || !opts.pinned.Equal(pub) {
			t.Error("want the pinned key resolved")
		}
		if !opts.allowUnsigned || !opts.allowUntrusted {
			t.Errorf("want both policy flags, got %+v", opts)
		}
	})

	t.Run("a bad key is refused", func(t *testing.T) {
		c := newCmd()
		if err := c.Flags().Set("key", "not-a-key"); err != nil {
			t.Fatal(err)
		}
		if _, err := verifyOptsFrom(c); err == nil {
			t.Error("expected a key-decode refusal")
		}
	})
}

// --- the command surface --------------------------------------------------------------------

// verifyEnv stands up isolated credentials and a fake control plane serving one job's receipt
// and the trusted-key set, and returns a runner through the real cobra tree.
func verifyEnv(t *testing.T, sr *verify.SignedReceipt, keys []map[string]any) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/cli/signing-keys"):
			if keys == nil {
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"signing_keys": keys})
		case strings.Contains(r.URL.Path, "/cli/jobs/"):
			meta := map[string]any{}
			if sr != nil {
				blob, _ := json.Marshal(sr)
				var asAny any
				_ = json.Unmarshal(blob, &asAny)
				meta["verify_receipt"] = asAny
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "job-1", "job_type": "DEPLOY", "status": "SUCCESS",
				"execution_metadata": meta,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not found: " + r.URL.Path})
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	resetVerifyFlags(t)

	return func(args ...string) error {
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	}
}

// resetVerifyFlags clears the group's persistent --job and the receipt command's own flags.
// cobra never resets a persistent flag between Execute calls, so without this one test's --job
// leaks into the next and the "no job" arm becomes unreachable.
func resetVerifyFlags(t *testing.T) {
	t.Helper()
	reset := func() {
		_ = verifyCmd.PersistentFlags().Set("job", "")
		_ = verifyReceiptCmd.Flags().Set("key", "")
		_ = verifyReceiptCmd.Flags().Set("key-file", "")
		_ = verifyReceiptCmd.Flags().Set("allow-unsigned", "false")
		_ = verifyReceiptCmd.Flags().Set("allow-untrusted", "false")
	}
	reset()
	t.Cleanup(reset)
}

// wireKey renders a public key the way the signing-keys endpoint serves it.
func wireKey(pub ed25519.PublicKey, source string) map[string]any {
	return map[string]any{
		"key_id":     verify.KeyID(pub),
		"public_key": base64.StdEncoding.EncodeToString(pub),
		"algorithm":  "ed25519",
		"source":     source,
		"provider":   nil,
		"status":     nil,
		"active":     true,
	}
}

func TestVerifyReceiptCmd(t *testing.T) {
	t.Run("verifies against the trusted set", func(t *testing.T) {
		sr, pub := signedFixture(t, sampleReport())
		run := verifyEnv(t, sr, []map[string]any{wireKey(pub, "platform")})
		exited, code, err := connInvoke(t, run, "verify", "receipt", "--job", "job-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("a verifiable receipt must not exit fatally (code %d)", code)
		}
	})

	t.Run("an untrusted key is fatal", func(t *testing.T) {
		sr, _ := signedFixture(t, sampleReport())
		other, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		run := verifyEnv(t, sr, []map[string]any{wireKey(other, "platform")})
		exited, code, err := connInvoke(t, run, "verify", "receipt", "--job", "job-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("an unvouched-for key must exit non-zero, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("--allow-untrusted forgives it", func(t *testing.T) {
		sr, _ := signedFixture(t, sampleReport())
		other, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		run := verifyEnv(t, sr, []map[string]any{wireKey(other, "platform")})
		exited, code, err := connInvoke(t, run, "verify", "receipt", "--job", "job-1", "--allow-untrusted")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("--allow-untrusted must exit clean (code %d)", code)
		}
	})

	t.Run("a job with no receipt is fatal", func(t *testing.T) {
		run := verifyEnv(t, nil, []map[string]any{})
		exited, code, err := connInvoke(t, run, "verify", "receipt", "--job", "job-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("want a fatal exit, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("--job is required", func(t *testing.T) {
		sr, pub := signedFixture(t, sampleReport())
		run := verifyEnv(t, sr, []map[string]any{wireKey(pub, "platform")})
		exited, code, err := connInvoke(t, run, "verify", "receipt")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("want a fatal exit, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("a malformed --key is fatal before any fetch", func(t *testing.T) {
		sr, pub := signedFixture(t, sampleReport())
		run := verifyEnv(t, sr, []map[string]any{wireKey(pub, "platform")})
		exited, code, err := connInvoke(t, run, "verify", "receipt", "--job", "job-1", "--key", "nonsense")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("want a fatal exit, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("--key-file pins a key off disk", func(t *testing.T) {
		sr, pub := signedFixture(t, sampleReport())
		// No trusted key set is served: the pinned path must not need one.
		run := verifyEnv(t, sr, nil)
		path := filepath.Join(t.TempDir(), "receipt.pub")
		if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(pub)), 0o600); err != nil {
			t.Fatal(err)
		}
		exited, code, err := connInvoke(t, run, "verify", "receipt", "--job", "job-1", "--key-file", path)
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("a pinned key must verify without the endpoint (code %d)", code)
		}
	})

	// An older control plane serves no signing-keys endpoint. Default: fatal and say why.
	t.Run("an absent endpoint degrades, not crashes", func(t *testing.T) {
		sr, _ := signedFixture(t, sampleReport())
		run := verifyEnv(t, sr, nil)
		exited, code, err := connInvoke(t, run, "verify", "receipt", "--job", "job-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("want a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}

func TestVerifyShowCmd(t *testing.T) {
	t.Run("renders a non-blocking report", func(t *testing.T) {
		sr, _ := signedFixture(t, sampleReport())
		run := verifyEnv(t, sr, []map[string]any{})
		exited, code, err := connInvoke(t, run, "verify", "show", "--job", "job-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("a non-blocking verdict must exit clean (code %d)", code)
		}
	})

	t.Run("a blocking verdict exits non-zero", func(t *testing.T) {
		sr, _ := signedFixture(t, failingReport())
		run := verifyEnv(t, sr, []map[string]any{})
		exited, code, err := connInvoke(t, run, "verify", "show", "--job", "job-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("a blocking verdict must exit non-zero, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("--job is required", func(t *testing.T) {
		sr, _ := signedFixture(t, sampleReport())
		run := verifyEnv(t, sr, []map[string]any{})
		exited, code, err := connInvoke(t, run, "verify", "show")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("want a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}

// Both verbs are read-only, but they still talk to the control plane, so both must refuse
// without credentials rather than proceeding unauthenticated.
func TestVerifyRequiresAuth(t *testing.T) {
	for _, args := range [][]string{
		{"verify", "receipt", "--job", "job-1"},
		{"verify", "show", "--job", "job-1"},
	} {
		t.Run(args[1], func(t *testing.T) {
			isolatedHome(t) // no credentials written
			t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
			resetVerifyFlags(t)
			run := func(a ...string) error {
				rootCmd.SetArgs(a)
				return rootCmd.Execute()
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code == 0 {
				t.Fatalf("an unauthenticated read must exit fatally, got exited=%v code=%d", exited, code)
			}
		})
	}
}
