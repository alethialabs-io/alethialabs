// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package kubeaccess is the credential channel for short-lived kubeconfigs (#5250 decisions 3, 7,
// 8; seams #5280).
//
// The client (the `alethia` CLI, or the browser through WebCrypto) generates an EPHEMERAL X25519
// keypair and sends only the public half with its mint request. The runner mints the credential
// in-network and seals it to that key with [Seal]; the console stores and relays the ciphertext and
// cannot open it; the client opens it with [ClientKey.Open]. The plaintext therefore exists on the
// runner and on the client and nowhere in between — not in the console, not in Postgres, not in
// execution_metadata or job_logs.
//
// # The construction, exactly — a second implementation (the browser) must reproduce it
//
//   - HPKE, RFC 9180, base mode (mode_base = 0x00), single shot (sequence number 0).
//   - Suite: KEM DHKEM(X25519, HKDF-SHA256) = 0x0020, KDF HKDF-SHA256 = 0x0001,
//     AEAD AES-256-GCM = 0x0002.
//   - info = the ASCII bytes of [SealInfo] ("alethia/kubeconfig-mint/v1"). Domain separation
//     only: it is constant for every mint.
//   - aad = [MintAAD](mintID, clusterID) = ASCII "alethia/kubeconfig-mint/v1" || 0x00 ||
//     mintID || 0x00 || clusterID, each id in canonical lowercase 8-4-4-4-12 UUID form exactly as
//     the console's wire carries it. Binding both means a sealed blob opens only for the request
//     it was minted for: replayed onto another mint (or the same mint id under another cluster) the
//     GCM tag fails.
//   - Wire form of the sealed result: base64url WITHOUT padding of enc (32 bytes) || ciphertext
//     (plaintext length + 16-byte tag). The client public key is base64url without padding of the
//     32-byte X25519 public key (RFC 7748 encoding, as WebCrypto's `exportKey("raw")` emits it).
//
// The primitive is Go's standard-library crypto/hpke; nothing here implements a KEM, a KDF or an
// AEAD. The RFC 9180 test vector for this exact suite is checked in seal_test.go and published in
// testdata/ for the browser implementation to check itself against.
package kubeaccess

import (
	"crypto/ecdh"
	"crypto/hpke"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// SealInfo is the HPKE `info` for every kubeconfig mint seal. Changing it is a wire break: every
// client in the field would fail to open what a runner seals.
const SealInfo = "alethia/kubeconfig-mint/v1"

// encLen is the size of a DHKEM(X25519) encapsulated key (Nenc, RFC 9180 §7.1).
const encLen = 32

// tagLen is the AES-256-GCM authentication tag size (Nt).
const tagLen = 16

// ErrSeal is wrapped by every error this package returns, so a caller can tell a channel failure
// from anything else without matching strings.
var ErrSeal = errors.New("kubeconfig seal")

// canonicalUUID is the only id form MintAAD accepts: lowercase, hyphenated, 36 characters. Postgres
// renders uuids this way; accepting any other spelling would let the two ends compute different AAD
// bytes for the same request and fail closed for a reason nobody could see.
var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var b64 = base64.RawURLEncoding.Strict()

// suite returns the three fixed HPKE components. It is the single place they are chosen.
func suite() (hpke.KEM, hpke.KDF, hpke.AEAD) {
	return hpke.DHKEM(ecdh.X25519()), hpke.HKDFSHA256(), hpke.AES256GCM()
}

// MintAAD builds the associated data that binds a sealed credential to one mint request on one
// cluster. Both ids must be canonical lowercase UUIDs.
func MintAAD(mintID, clusterID string) ([]byte, error) {
	if !canonicalUUID.MatchString(mintID) {
		return nil, fmt.Errorf("%w: mint id %q is not a canonical lowercase uuid", ErrSeal, mintID)
	}
	if !canonicalUUID.MatchString(clusterID) {
		return nil, fmt.Errorf("%w: cluster id %q is not a canonical lowercase uuid", ErrSeal, clusterID)
	}
	aad := make([]byte, 0, len(SealInfo)+2+len(mintID)+len(clusterID))
	aad = append(aad, SealInfo...)
	aad = append(aad, 0)
	aad = append(aad, mintID...)
	aad = append(aad, 0)
	aad = append(aad, clusterID...)
	return aad, nil
}

// Seal encrypts plaintext (the JSON of a types.KubeconfigMintCredential) to the client's public
// key, bound to the mint and cluster ids, and returns the wire form (base64url of enc || ct). It is
// the RUNNER's half of the channel; a fresh ephemeral key is generated on every call.
func Seal(clientPublicKeyB64 string, mintID, clusterID string, plaintext []byte) (string, error) {
	rawPub, err := types.DecodeKubeconfigMintPublicKey(clientPublicKeyB64)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrSeal, err)
	}
	kem, _, _ := suite()
	pub, err := kem.NewPublicKey(rawPub)
	if err != nil {
		return "", fmt.Errorf("%w: client public key: %w", ErrSeal, err)
	}
	aad, err := MintAAD(mintID, clusterID)
	if err != nil {
		return "", err
	}
	blob, err := sealTo(pub, []byte(SealInfo), aad, plaintext)
	if err != nil {
		return "", err
	}
	out := b64.EncodeToString(blob)
	if len(out) > types.KubeconfigMintSealedMaxLength {
		return "", fmt.Errorf("%w: sealed credential is %d chars, over the %d the console accepts", ErrSeal, len(out), types.KubeconfigMintSealedMaxLength)
	}
	return out, nil
}

// sealTo is the single-shot HPKE base-mode seal under the fixed suite: enc || Seal(aad, pt).
func sealTo(pub hpke.PublicKey, info, aad, plaintext []byte) ([]byte, error) {
	_, kdf, aead := suite()
	enc, sender, err := hpke.NewSender(pub, kdf, aead, info)
	if err != nil {
		return nil, fmt.Errorf("%w: hpke setup: %w", ErrSeal, err)
	}
	ct, err := sender.Seal(aad, plaintext)
	if err != nil {
		return nil, fmt.Errorf("%w: hpke seal: %w", ErrSeal, err)
	}
	out := make([]byte, 0, len(enc)+len(ct))
	out = append(out, enc...)
	return append(out, ct...), nil
}

// openWith is the single-shot HPKE base-mode open under the fixed suite. Split out so the RFC 9180
// vector exercises the exact code path Open uses, with the vector's own info and aad.
func openWith(priv hpke.PrivateKey, info, aad, blob []byte) ([]byte, error) {
	if len(blob) < encLen+tagLen {
		return nil, fmt.Errorf("%w: sealed credential is %d bytes, shorter than enc + tag", ErrSeal, len(blob))
	}
	_, kdf, aead := suite()
	recipient, err := hpke.NewRecipient(blob[:encLen], priv, kdf, aead, info)
	if err != nil {
		return nil, fmt.Errorf("%w: hpke setup: %w", ErrSeal, err)
	}
	pt, err := recipient.Open(aad, blob[encLen:])
	if err != nil {
		// Deliberately not distinguishing a wrong key from a wrong AAD from a tampered blob: the
		// caller's answer is the same (mint again), and the distinction is an oracle.
		return nil, fmt.Errorf("%w: the sealed credential does not open for this key, mint and cluster", ErrSeal)
	}
	return pt, nil
}

// ClientKey is the client's ephemeral X25519 keypair for ONE mint. It lives in memory for the length
// of a request-and-poll and is never written to disk; a new mint uses a new key.
type ClientKey struct {
	priv hpke.PrivateKey
}

// GenerateClientKey creates a fresh ephemeral keypair from crypto/rand. It is the CLIENT's half.
func GenerateClientKey() (*ClientKey, error) {
	kem, _, _ := suite()
	priv, err := kem.GenerateKey()
	if err != nil {
		return nil, fmt.Errorf("%w: generate client key: %w", ErrSeal, err)
	}
	return &ClientKey{priv: priv}, nil
}

// PublicKey returns the public half in the wire form the mint request carries (base64url, no
// padding, 43 characters).
func (k *ClientKey) PublicKey() string {
	return b64.EncodeToString(k.priv.PublicKey().Bytes())
}

// Open decrypts the wire form of a sealed credential minted for (mintID, clusterID). It fails for a
// blob sealed to another key, bound to another mint or cluster, or altered in transit.
func (k *ClientKey) Open(sealedB64, mintID, clusterID string) ([]byte, error) {
	blob, err := b64.DecodeString(sealedB64)
	if err != nil {
		return nil, fmt.Errorf("%w: sealed credential is not unpadded base64url: %w", ErrSeal, err)
	}
	aad, err := MintAAD(mintID, clusterID)
	if err != nil {
		return nil, err
	}
	return openWith(k.priv, []byte(SealInfo), aad, blob)
}
