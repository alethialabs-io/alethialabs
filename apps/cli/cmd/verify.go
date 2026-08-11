// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/spf13/cobra"
)

var verifyCmd = &cobra.Command{
	Use:   "verify",
	Short: "Inspect and verify a job's signed evidence receipt",
	Long: `Every PLAN and DEPLOY job carries an elench evidence receipt: the per-control
verification report, sealed to the hash of the exact OpenTofu plan that was applied, and signed
with ed25519.

` + "`alethia verify receipt`" + ` pulls that receipt and checks its signature against a key the
control plane vouches for, exiting non-zero when it cannot — so a pipeline can gate on it.
` + "`alethia verify show`" + ` prints the per-control report behind the verdict, including the
controls that could not be evaluated and any recorded waiver.`,
}

// currentJob resolves the --job flag. Mirrors currentProject (project_env.go): the flag is the
// only source, and its absence is a named error rather than a request against job id "".
func currentJob(cmd *cobra.Command) (string, error) {
	if j, _ := cmd.Flags().GetString("job"); j != "" {
		return j, nil
	}
	return "", fmt.Errorf("--job is required (pass the job id, e.g. from `alethia jobs list`)")
}

// errNoReceipt is returned when a job carries no evidence receipt at all. Its own error so the
// caller can say WHY rather than reporting a verification failure for something never signed.
var errNoReceipt = fmt.Errorf("this job carries no evidence receipt")

// receiptFromJob extracts the typed SignedReceipt from a job's execution_metadata.
//
// execution_metadata arrives as an untyped map (api.ProvisionJob.ExecutionMetadata), so the
// receipt sub-tree is re-marshalled and decoded into the real struct rather than hand-walked:
// the signature is checked over canonicalBytes(Receipt) == json.Marshal of that struct, so the
// typed round trip is what reproduces the signed bytes. Hand-walking the map would not.
func receiptFromJob(job *api.ProvisionJob) (*verify.SignedReceipt, error) {
	if job == nil || job.ExecutionMetadata == nil {
		return nil, errNoReceipt
	}
	raw, ok := (*job.ExecutionMetadata)["verify_receipt"]
	if !ok || raw == nil {
		return nil, errNoReceipt
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("re-encode receipt: %w", err)
	}
	var sr verify.SignedReceipt
	if err := json.Unmarshal(blob, &sr); err != nil {
		return nil, fmt.Errorf("decode receipt: %w", err)
	}
	return &sr, nil
}

// trustLevel names WHO vouches for the key a receipt was signed with. It is the difference
// between "this blob is internally consistent" and "Alethia signed this", and the command's exit
// status turns on it.
type trustLevel string

const (
	// trustPinned — the signature verified under a key the OPERATOR supplied out of band
	// (--key/--key-file). The strongest answer available: it depends on nothing the control
	// plane said.
	trustPinned trustLevel = "pinned"
	// trustOrg — the key_id resolved to an active key in the org's own recorded history.
	trustOrg trustLevel = "org"
	// trustPlatform — the key_id resolved to the Alethia platform key. Attests "Alethia
	// asserted this", not "the customer asserted this".
	trustPlatform trustLevel = "platform"
	// trustSelf — only the receipt's OWN embedded key verified. Proves the blob was not
	// mangled; proves nothing about who made it.
	trustSelf trustLevel = "self"
	// trustNone — no signature to reason about (an unsigned receipt).
	trustNone trustLevel = "none"
)

// trustedKeys resolves a key_id to the public key the control plane recorded for it. This is the
// first production implementation of verify.TrustedKeys — the interface has existed since #884
// with only tests behind it.
type trustedKeys struct {
	byKeyID map[string]api.SigningKey
}

// newTrustedKeys indexes a fetched key set by key_id. A malformed public key is skipped rather
// than failing the whole set: one bad row must not make every other key unusable.
func newTrustedKeys(keys []api.SigningKey) *trustedKeys {
	byKeyID := make(map[string]api.SigningKey, len(keys))
	for _, k := range keys {
		if k.KeyID == "" {
			continue
		}
		if _, err := decodePublicKey(k.PublicKey); err != nil {
			continue
		}
		byKeyID[k.KeyID] = k
	}
	return &trustedKeys{byKeyID: byKeyID}
}

// PublicKeyForKeyID implements verify.TrustedKeys.
func (t *trustedKeys) PublicKeyForKeyID(keyID string) (ed25519.PublicKey, bool) {
	k, ok := t.byKeyID[keyID]
	if !ok {
		return nil, false
	}
	pub, err := decodePublicKey(k.PublicKey)
	if err != nil {
		return nil, false
	}
	return pub, true
}

// sourceFor reports the trust level a resolved key_id earns.
//
// Every arm is explicit on purpose. Defaulting the unknown cases to trustPlatform would print
// "verified against the Alethia platform key" for a key that is nothing of the sort — a specific
// claim about custody that this CLI would not actually have checked. A trust label that overstates
// is worse than one that admits it does not know.
func (t *trustedKeys) sourceFor(keyID string) trustLevel {
	k, ok := t.byKeyID[keyID]
	if !ok {
		// Unreachable through verifyReceipt, which only calls this after VerifyTrusted has
		// already resolved the id. Reached any other way, nothing vouched for this key.
		return trustNone
	}
	switch k.Source {
	case "org":
		return trustOrg
	case "platform":
		return trustPlatform
	case "":
		// The set resolved the key but does not say who vouches for it. That is not a custody
		// model to report verbatim — it is the absence of an answer, and the caller fails closed.
		return trustNone
	default:
		// A custody model this CLI predates. The control plane still vouched for the key, so the
		// signature is trusted — but report the source verbatim rather than relabel it as one of
		// the two we happen to know.
		return trustLevel(k.Source)
	}
}

// decodePublicKey parses a base64(std) ed25519 public key. The same encoding the console stores
// and the receipt embeds, so one parser serves --key, the wire, and the receipt itself.
func decodePublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, fmt.Errorf("not valid base64: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("expected a %d-byte ed25519 public key, got %d bytes", ed25519.PublicKeySize, len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

// pinnedKey resolves --key / --key-file into a public key, or nil when neither was given.
// Two flags rather than one value that might be a path: a flag whose meaning depends on whether
// the filesystem happens to contain a matching name is not something a pipeline can rely on.
func pinnedKey(keyB64, keyFile string) (ed25519.PublicKey, error) {
	if keyB64 != "" && keyFile != "" {
		return nil, fmt.Errorf("pass --key or --key-file, not both")
	}
	if keyB64 != "" {
		pub, err := decodePublicKey(keyB64)
		if err != nil {
			return nil, fmt.Errorf("--key: %w", err)
		}
		return pub, nil
	}
	if keyFile != "" {
		data, err := os.ReadFile(keyFile)
		if err != nil {
			return nil, fmt.Errorf("--key-file: %w", err)
		}
		pub, err := decodePublicKey(string(data))
		if err != nil {
			return nil, fmt.Errorf("--key-file: %w", err)
		}
		return pub, nil
	}
	return nil, nil
}

func init() {
	verifyCmd.PersistentFlags().StringP("job", "j", "", "Job id whose evidence receipt to read")
	verifyCmd.AddCommand(verifyReceiptCmd)
	verifyCmd.AddCommand(verifyShowCmd)
	rootCmd.AddCommand(verifyCmd)
}
