// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	return pub, priv
}

func TestSignReceiptWith_InProcess_SelfVerifies(t *testing.T) {
	pub, priv := newKey(t)
	signer, err := NewInProcessSigner(priv)
	if err != nil {
		t.Fatalf("NewInProcessSigner: %v", err)
	}
	r := Receipt{Version: ReceiptVersion, Runner: "test"}

	sr, err := SignReceiptWith(r, signer)
	if err != nil {
		t.Fatalf("SignReceiptWith: %v", err)
	}
	// Embedded public key present + matches the signer.
	if sr.PublicKey != base64.StdEncoding.EncodeToString(pub) {
		t.Errorf("embedded PublicKey mismatch")
	}
	if sr.KeyID != KeyID(pub) {
		t.Errorf("KeyID mismatch: %s vs %s", sr.KeyID, KeyID(pub))
	}
	// Self-verify (embedded key) passes.
	if err := sr.VerifySelf(); err != nil {
		t.Errorf("VerifySelf: %v", err)
	}
	// Explicit verify (external key) passes.
	if err := sr.Verify(pub); err != nil {
		t.Errorf("Verify: %v", err)
	}
}

func TestSignReceiptWith_TamperFailsClosed(t *testing.T) {
	_, priv := newKey(t)
	signer, _ := NewInProcessSigner(priv)
	sr, _ := SignReceiptWith(Receipt{Version: ReceiptVersion, Runner: "a"}, signer)
	// Tamper with the receipt after signing.
	sr.Receipt.Runner = "b"
	if err := sr.VerifySelf(); err == nil {
		t.Errorf("expected tamper to fail self-verify")
	}
}

func TestNewInProcessSigner_RejectsBadKey(t *testing.T) {
	if _, err := NewInProcessSigner(ed25519.PrivateKey([]byte("short"))); err == nil {
		t.Errorf("expected error for short private key")
	}
}

// stubTrusted implements TrustedKeys from a map.
type stubTrusted map[string]ed25519.PublicKey

func (s stubTrusted) PublicKeyForKeyID(keyID string) (ed25519.PublicKey, bool) {
	k, ok := s[keyID]
	return k, ok
}

func TestVerifyTrusted_BindsToRecordedKey(t *testing.T) {
	pub, priv := newKey(t)
	signer, _ := NewInProcessSigner(priv)
	sr, _ := SignReceiptWith(Receipt{Version: ReceiptVersion, Runner: "x"}, signer)

	// key_id recorded in history → verifies.
	trusted := stubTrusted{KeyID(pub): pub}
	if err := sr.VerifyTrusted(trusted); err != nil {
		t.Errorf("VerifyTrusted (recorded): %v", err)
	}

	// key_id NOT in history → fails closed, even though the receipt self-verifies.
	if err := sr.VerifyTrusted(stubTrusted{}); err == nil {
		t.Errorf("expected fail-closed when key_id is not recorded")
	}
}

func TestVerifyTrusted_RejectsForgedEmbeddedKey(t *testing.T) {
	// An attacker re-signs a receipt with THEIR key and embeds their public key. Self-verify
	// would pass, but VerifyTrusted must reject it because the recorded key for the org differs.
	orgPub, _ := newKey(t)
	_, attackerPriv := newKey(t)
	attackerSigner, _ := NewInProcessSigner(attackerPriv)
	forged, _ := SignReceiptWith(Receipt{Version: ReceiptVersion, Runner: "x"}, attackerSigner)

	// Force the forged receipt to CLAIM the org's key_id (spoofing attempt).
	forged.KeyID = KeyID(orgPub)
	trusted := stubTrusted{KeyID(orgPub): orgPub}
	if err := forged.VerifyTrusted(trusted); err == nil {
		t.Errorf("expected forged receipt (attacker key, org key_id) to fail VerifyTrusted")
	}
}

func TestSigningBackend_Valid(t *testing.T) {
	if !SigningBackendKMS.Valid() || !SigningBackendSecret.Valid() {
		t.Errorf("known backends should be valid")
	}
	if SigningBackend("bogus").Valid() {
		t.Errorf("unknown backend should be invalid")
	}
}
