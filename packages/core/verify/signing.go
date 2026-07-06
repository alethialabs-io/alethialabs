// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

// SigningKeyEnv is the environment variable holding the base64-encoded (std)
// 64-byte ed25519 private key used to sign evidence receipts.
const SigningKeyEnv = "ALETHIA_RECEIPT_SIGNING_KEY"

// SigningKeyFromEnv loads the receipt-signing key from SigningKeyEnv. When the
// variable is unset it returns ok=false (and a nil error) so the caller can
// attach an UNSIGNED receipt rather than fail the apply — signing is additive
// evidence, not a precondition for provisioning.
//
// Production note: for the receipt to mean something to a customer's auditor the
// signing key should be one the customer controls (or the signature anchored in a
// transparency log such as Rekor). A platform-held key only attests "Alethia said
// so". This loader is the seam; key custody is a deployment decision.
func SigningKeyFromEnv() (priv ed25519.PrivateKey, keyID string, ok bool, err error) {
	raw := strings.TrimSpace(os.Getenv(SigningKeyEnv))
	if raw == "" {
		return nil, "", false, nil
	}
	b, derr := base64.StdEncoding.DecodeString(raw)
	if derr != nil {
		return nil, "", false, fmt.Errorf("%s: not valid base64: %w", SigningKeyEnv, derr)
	}
	if len(b) != ed25519.PrivateKeySize {
		return nil, "", false, fmt.Errorf("%s: expected a %d-byte ed25519 private key, got %d bytes", SigningKeyEnv, ed25519.PrivateKeySize, len(b))
	}
	priv = ed25519.PrivateKey(b)
	pub, _ := priv.Public().(ed25519.PublicKey)
	return priv, KeyID(pub), true, nil
}
