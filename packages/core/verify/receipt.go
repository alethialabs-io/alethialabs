// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// ReceiptVersion identifies the receipt schema. Bump on any breaking field change.
const ReceiptVersion = "elench-receipt-1"

// Receipt is the per-apply evidence record: a precise, honest statement of what
// the verification gate checked, against which plan, with which control set. It is
// deliberately framed as evidence of what *our runner checked* — not a compliance
// proof. Its value comes from being (a) reproducible-verdict-given-the-same-plan,
// and (b) tamper-evident once signed (see SignedReceipt).
//
// The root of trust matters: a signature from Alethia's own runner only proves
// "Alethia asserted this". To make a receipt valuable to a customer's auditor,
// sign with a per-customer-controlled key and/or anchor the signature in a
// transparency log (Rekor) — see SigningKeyFromEnv and the package README.
type Receipt struct {
	Version string `json:"version"`
	// PlanSHA256 binds the receipt to the exact plan that was evaluated.
	PlanSHA256 string `json:"plan_sha256"`
	// TofuVersion / ProviderVersions / CatalogVersion pin what produced the
	// verdict — a verdict is only meaningful against the schema + controls used.
	TofuVersion      string            `json:"tofu_version,omitempty"`
	ProviderVersions map[string]string `json:"provider_versions,omitempty"`
	CatalogVersion   string            `json:"catalog_version"`
	Provider         string            `json:"provider"`
	Verdict          Status            `json:"verdict"`
	Report           *Report           `json:"report"`
	// Exception records an authorized, time-boxed override that allowed an apply
	// to proceed despite a failing control (nil if none).
	Exception *RecordedException `json:"exception,omitempty"`
	// Runner identifies the executor that produced the receipt.
	Runner string `json:"runner,omitempty"`
	// EvaluatedAt is an RFC3339 timestamp supplied by the caller (kept out of the
	// pure evaluation path so signing stays deterministic in tests).
	EvaluatedAt string `json:"evaluated_at,omitempty"`
}

// RecordedException is an override as it appears in the sealed receipt.
type RecordedException struct {
	Controls []string `json:"controls"`
	Reason   string   `json:"reason"`
	By       string   `json:"by"`
	Expiry   string   `json:"expiry,omitempty"`
}

// SignedReceipt is a Receipt plus a detached signature over its canonical bytes.
type SignedReceipt struct {
	Receipt   Receipt `json:"receipt"`
	Algorithm string  `json:"algorithm"`
	KeyID     string  `json:"key_id"`
	Signature string  `json:"signature"` // base64(standard) of the detached signature
	// PublicKey is the base64(standard) ed25519 public key the signature verifies under.
	// Embedding it makes a receipt SELF-verifiable by an external auditor with no lookup
	// (#884) — but "does this key belong to the org?" is answered out-of-band (the retained
	// key_id→public-key history, a published fingerprint, or the Rekor anchor #885), never
	// by trusting this field blindly. Empty on unsigned receipts / older signatures.
	PublicKey string `json:"public_key,omitempty"`
}

// BuildReceiptParams collects everything needed to assemble a Receipt.
type BuildReceiptParams struct {
	Report           *Report
	PlanBytes        []byte
	TofuVersion      string
	ProviderVersions map[string]string
	Override         *Override
	Runner           string
	EvaluatedAt      string // RFC3339, caller-supplied
}

// BuildReceipt assembles a Receipt from a verification report and apply context.
func BuildReceipt(p BuildReceiptParams) Receipt {
	r := Receipt{
		Version:          ReceiptVersion,
		PlanSHA256:       PlanSHA256(p.PlanBytes),
		TofuVersion:      p.TofuVersion,
		ProviderVersions: p.ProviderVersions,
		CatalogVersion:   CatalogVersion,
		Runner:           p.Runner,
		EvaluatedAt:      p.EvaluatedAt,
	}
	if p.Report != nil {
		r.Report = p.Report
		r.Provider = p.Report.Provider
		r.Verdict = p.Report.Verdict
		// If an override waived every failing control, the *effective* outcome is
		// "allowed with a recorded exception" — capture that honestly.
		if p.Override != nil && len(p.Override.Controls) > 0 {
			r.Exception = &RecordedException{
				Controls: p.Override.Controls,
				Reason:   p.Override.Reason,
				By:       p.Override.By,
			}
			if !p.Override.Expiry.IsZero() {
				r.Exception.Expiry = p.Override.Expiry.UTC().Format("2006-01-02T15:04:05Z07:00")
			}
		}
	}
	return r
}

// PlanSHA256 returns the lowercase-hex SHA-256 of the plan bytes (empty string for
// no bytes, so an unsigned/absent plan is visible rather than a hash of nothing).
func PlanSHA256(planBytes []byte) string {
	if len(planBytes) == 0 {
		return ""
	}
	sum := sha256.Sum256(planBytes)
	return hex.EncodeToString(sum[:])
}

// canonicalBytes produces the deterministic byte representation a signature is
// computed over. encoding/json is deterministic here: struct fields serialize in
// declaration order and map keys are sorted, so the same Receipt always yields the
// same bytes.
func canonicalBytes(r Receipt) ([]byte, error) {
	return json.Marshal(r)
}

// KeyID derives a short, stable identifier for an ed25519 public key.
func KeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

// Sign produces a SignedReceipt by signing the receipt's canonical bytes with an
// ed25519 private key.
func Sign(r Receipt, priv ed25519.PrivateKey, keyID string) (*SignedReceipt, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid ed25519 private key length %d", len(priv))
	}
	msg, err := canonicalBytes(r)
	if err != nil {
		return nil, fmt.Errorf("canonicalize receipt: %w", err)
	}
	sig := ed25519.Sign(priv, msg)
	sr := &SignedReceipt{
		Receipt:   r,
		Algorithm: "ed25519",
		KeyID:     keyID,
		Signature: base64.StdEncoding.EncodeToString(sig),
	}
	if pub, ok := priv.Public().(ed25519.PublicKey); ok {
		sr.PublicKey = base64.StdEncoding.EncodeToString(pub)
	}
	return sr, nil
}

// Verify checks that a SignedReceipt's signature matches its receipt under the
// given public key. A non-nil error means the receipt was tampered with, was
// signed by a different key, or is malformed.
func (s *SignedReceipt) Verify(pub ed25519.PublicKey) error {
	if s == nil {
		return fmt.Errorf("nil signed receipt")
	}
	if s.Algorithm != "ed25519" {
		return fmt.Errorf("unsupported signature algorithm %q", s.Algorithm)
	}
	if len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid ed25519 public key length %d", len(pub))
	}
	sig, err := base64.StdEncoding.DecodeString(s.Signature)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	msg, err := canonicalBytes(s.Receipt)
	if err != nil {
		return fmt.Errorf("canonicalize receipt: %w", err)
	}
	if !ed25519.Verify(pub, msg, sig) {
		return fmt.Errorf("signature does not match receipt (tampered, or wrong key)")
	}
	return nil
}

// VerifySelf checks the signature against the receipt's OWN embedded PublicKey (#884). It
// proves internal consistency — the signature matches the receipt under the embedded key —
// but NOT that the embedded key is the org's real key. A caller that cares who signed must
// still bind KeyID to a trusted public key (the retained history or the Rekor anchor) and
// compare it to PublicKey. Returns an error when no key is embedded.
func (s *SignedReceipt) VerifySelf() error {
	if s == nil {
		return fmt.Errorf("nil signed receipt")
	}
	if s.PublicKey == "" {
		return fmt.Errorf("receipt has no embedded public key to self-verify")
	}
	pub, err := base64.StdEncoding.DecodeString(s.PublicKey)
	if err != nil {
		return fmt.Errorf("decode embedded public key: %w", err)
	}
	return s.Verify(ed25519.PublicKey(pub))
}
