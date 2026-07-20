// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
)

// This file is the customer-controlled-root-of-trust seam (#884). A platform-held key only
// attests "Alethia asserted this"; an org's OWN key makes the receipt attest the customer.
// Custody model A: Alethia holds only a REFERENCE + the PUBLIC key — never the private key.
// The concrete per-cloud signers (KMS-native on AWS/GCP, secret-fetch elsewhere) live in the
// runner (a follow-on); this package defines the abstraction + the in-process fallback signer.

// SigningBackend is how an org's ed25519 key is held and invoked. Mirrors the signing_backend
// pg enum (apps/console/lib/db/schema/enums.ts).
type SigningBackend string

const (
	// SigningBackendKMS: the key lives in the customer's cloud KMS (AWS ECC_NIST_EDWARDS25519 /
	// GCP EC_SIGN_ED25519); the runner signs via the KMS Sign API — the key never leaves the HSM.
	SigningBackendKMS SigningBackend = "kms"
	// SigningBackendSecret: the raw ed25519 key lives in the customer's secret store (Azure Key
	// Vault / Alibaba / Hetzner); the runner fetches it, signs in-process, then zeroizes it.
	SigningBackendSecret SigningBackend = "secret"
)

// AllSigningBackends is the closed set of backends.
var AllSigningBackends = []SigningBackend{SigningBackendKMS, SigningBackendSecret}

// Valid reports whether b is a known backend.
func (b SigningBackend) Valid() bool {
	return b == SigningBackendKMS || b == SigningBackendSecret
}

// SigningKeyConfig is an org's resolved receipt-signing key reference (#884). It carries a
// REFERENCE plus the PUBLIC key only — never the private key (custody model A). The runner
// resolves this against the project's provisioning cloud (Provider must match to be reachable
// keyless) and builds the matching Signer.
type SigningKeyConfig struct {
	Provider  string            // cloud the key lives in; must match the project's cloud to be reachable
	Backend   SigningBackend    // kms | secret
	KeyRef    string            // KMS key resource id (kms) or secret ARN/URI (secret)
	PublicKey ed25519.PublicKey // the key signatures verify under
	KeyID     string            // stable KeyID(PublicKey)
}

// Signer signs a receipt's canonical bytes and reports the public key + key id the signature
// verifies under. Implementations: InProcessSigner (this package — the platform key and the
// secret-ref fallback) and per-cloud KMS signers (the runner, a follow-on). The seam lets
// receipt signing swap the platform key for a customer-controlled key without changing the
// receipt format.
type Signer interface {
	Sign(canonical []byte) (sig []byte, err error)
	Public() ed25519.PublicKey
	KeyID() string
}

// InProcessSigner signs with a raw ed25519 private key held in memory — used for the platform
// key (SigningKeyFromEnv) and, in the runner, the secret-ref backend after fetching the key.
type InProcessSigner struct {
	priv  ed25519.PrivateKey
	pub   ed25519.PublicKey
	keyID string
}

// NewInProcessSigner builds an in-process ed25519 signer from a private key.
func NewInProcessSigner(priv ed25519.PrivateKey) (*InProcessSigner, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid ed25519 private key length %d", len(priv))
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("private key does not yield an ed25519 public key")
	}
	return &InProcessSigner{priv: priv, pub: pub, keyID: KeyID(pub)}, nil
}

// Sign returns the ed25519 signature over canonical.
func (s *InProcessSigner) Sign(canonical []byte) ([]byte, error) {
	return ed25519.Sign(s.priv, canonical), nil
}

// Public returns the ed25519 public key.
func (s *InProcessSigner) Public() ed25519.PublicKey { return s.pub }

// KeyID returns the stable key identifier.
func (s *InProcessSigner) KeyID() string { return s.keyID }

// SignReceiptWith signs a receipt with any Signer, embedding the signer's public key + key id
// so the receipt is self-verifiable (#884). This is the seam receipt signing should call, so a
// platform key, a secret-ref key, or a KMS-backed key all produce an identical receipt shape.
// It fails closed: it never returns a signature the signer's own public key can't verify.
func SignReceiptWith(r Receipt, s Signer) (*SignedReceipt, error) {
	if s == nil {
		return nil, fmt.Errorf("nil signer")
	}
	msg, err := canonicalBytes(r)
	if err != nil {
		return nil, fmt.Errorf("canonicalize receipt: %w", err)
	}
	sig, err := s.Sign(msg)
	if err != nil {
		return nil, fmt.Errorf("sign receipt: %w", err)
	}
	pub := s.Public()
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("signer returned invalid ed25519 public key length %d", len(pub))
	}
	if !ed25519.Verify(pub, msg, sig) {
		return nil, fmt.Errorf("signer produced a signature its own public key does not verify")
	}
	return &SignedReceipt{
		Receipt:   r,
		Algorithm: "ed25519",
		KeyID:     s.KeyID(),
		Signature: base64.StdEncoding.EncodeToString(sig),
		PublicKey: base64.StdEncoding.EncodeToString(pub),
	}, nil
}

// TrustedKeys resolves a key_id to the public key Alethia recorded for it (the retained
// key_id→public-key history that survives rotation, #884).
type TrustedKeys interface {
	PublicKeyForKeyID(keyID string) (ed25519.PublicKey, bool)
}

// VerifyTrusted verifies a receipt against the public key Alethia RECORDED for its key_id,
// not the receipt's self-asserted PublicKey. This is what binds a signature to an org: a
// receipt whose key_id isn't in the trusted history fails closed, even if it embeds a
// well-formed self-consistent signature.
func (s *SignedReceipt) VerifyTrusted(keys TrustedKeys) error {
	if s == nil {
		return fmt.Errorf("nil signed receipt")
	}
	if keys == nil {
		return fmt.Errorf("nil trusted-key source")
	}
	pub, ok := keys.PublicKeyForKeyID(s.KeyID)
	if !ok {
		return fmt.Errorf("no trusted public key recorded for key_id %q", s.KeyID)
	}
	return s.Verify(pub)
}
