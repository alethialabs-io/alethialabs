// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/bits"
)

// This file is the Rekor transparency-log anchor (#885) — the "append-only record" leg of the
// evidence custody chain. A signed receipt (#884) is tamper-evident and offline-verifiable, but
// a verifier still has no third-party proof the receipt *existed at a point in time in a
// permanent record*. Entering the receipt's digest into a Rekor transparency log closes that
// gap: anyone can later confirm, entirely offline, that the entry was included.
//
// Key design decisions (researched + settled; see packages/core/verify/README.md and the
// evidence-custody-chain spec):
//
//   - The receipt is logged as a `hashedrekord` entry — a HASH only, never the receipt body
//     (which references the customer's plan/infra data). The privacy property is structural:
//     hashedrekord has no body field.
//   - The logged signature is a DEDICATED platform ECDSA-P256 "anchor signature" over
//     sha256(canonical receipt), SEPARATE from the ed25519 receipt signature. `hashedrekord`
//     verifies the digest only, and PureEd25519 (RFC 8032) signs the full message — so a
//     pure-ed25519 signature cannot be verified against a bare digest and Rekor rejects it
//     (sigstore/rekor#851). ECDSA-P256 signs over a digest and is accepted on Rekor v1 and v2.
//   - Anchoring happens CONSOLE-SIDE (the control plane), not in the untrusted runner sandbox.
//     This Go verifier is the auditor-grade offline check; the console produces the anchor.
//
// SCOPE BOUNDARY (honest, no silent cap): VerifyAnchor proves INCLUSION — the log's signed
// entry timestamp (the log operator's signed promise of inclusion) plus the RFC 6962 Merkle
// audit path to the proof's root, plus that the logged entry binds to this exact receipt. It
// does NOT detect a forked / split-view log: that needs a consistency monitor / witness across
// checkpoints (the "keep proving it" north-star leg). The signed checkpoint is therefore
// STORED on the anchor for that future monitor, and its tree size / root hash are asserted
// consistent with the inclusion proof, but its note signature is not the trust anchor here —
// the SignedEntryTimestamp is.

// RekorAnchor is a self-contained, offline-verifiable proof that a receipt's digest was entered
// into a Rekor transparency log. Everything needed to verify inclusion with no callback to
// Alethia or to Rekor is carried inline (the Sigstore "bundle" shape, v1-populated / v2-forward).
type RekorAnchor struct {
	// LogURL is the Rekor instance the entry was submitted to (audit provenance; the public
	// good instance by default, or a customer/self-hosted instance).
	LogURL string `json:"log_url,omitempty"`
	// LogID is the lowercase-hex SHA-256 of the DER-encoded log public key (identifies which
	// log — and thus which pinned public key — verifies this anchor).
	LogID string `json:"log_id"`
	// LogIndex is the entry's global index in the log.
	LogIndex int64 `json:"log_index"`
	// IntegratedTime is the log's self-asserted integration time (Unix seconds, Rekor v1).
	// It is NOT externally trustworthy on its own — auditor-grade time is an RFC 3161
	// timestamp (a named follow-on), not this field. Kept for provenance / display only.
	IntegratedTime int64 `json:"integrated_time,omitempty"`
	// Body is the base64(std) canonicalized `hashedrekord` entry exactly as the log stored it
	// (the leaf whose hash the inclusion proof covers).
	Body string `json:"body"`
	// InclusionProof is the RFC 6962 Merkle audit path + signed checkpoint.
	InclusionProof RekorInclusionProof `json:"inclusion_proof"`
	// SignedEntryTimestamp is the base64(std) SET — the log key's signature over
	// {body, integratedTime, logID, logIndex} (Rekor v1). This is the log operator's signed
	// promise of inclusion and the primary trust anchor of an offline verify. (Rekor v2 drops
	// the SET for a signed checkpoint + external RFC 3161 time; empty then.)
	SignedEntryTimestamp string `json:"signed_entry_timestamp,omitempty"`
	// AnchorAlgorithm names the anchor-signature scheme (always ecdsa-p256-sha256 today).
	AnchorAlgorithm string `json:"anchor_algorithm"`
	// AnchorSignature is the base64(std) ASN.1-DER ECDSA-P256 signature over
	// sha256(canonical receipt) — the value that was logged as the hashedrekord signature.
	AnchorSignature string `json:"anchor_signature"`
	// AnchorPublicKey is the base64(std) of the PEM-encoded (PKIX) ECDSA-P256 public key the
	// anchor signature verifies under — exactly the bytes logged as the hashedrekord publicKey.
	AnchorPublicKey string `json:"anchor_public_key"`
}

// RekorInclusionProof is the RFC 6962 audit path proving the entry is in the tree, plus the
// log's signed checkpoint (tree head).
type RekorInclusionProof struct {
	LogIndex int64 `json:"log_index"`
	// RootHash is the lowercase-hex Merkle root the audit path resolves to.
	RootHash string `json:"root_hash"`
	TreeSize int64  `json:"tree_size"`
	// Hashes is the lowercase-hex audit path (sibling hashes leaf→root).
	Hashes []string `json:"hashes"`
	// Checkpoint is the log's signed tree head (a signed note). Stored for the consistency
	// monitor / witness follow-on; its tree size + root hash are asserted consistent with this
	// proof by VerifyAnchor.
	Checkpoint string `json:"checkpoint,omitempty"`
}

// AnchorDigest returns the sha256 of a receipt's canonical bytes — the digest the platform
// ECDSA-P256 anchor signature signs and the value logged in the hashedrekord entry. It is the
// binding between "this receipt" and "that log entry".
func AnchorDigest(r Receipt) ([]byte, error) {
	msg, err := canonicalBytes(r)
	if err != nil {
		return nil, fmt.Errorf("canonicalize receipt: %w", err)
	}
	sum := sha256.Sum256(msg)
	return sum[:], nil
}

// hashedRekordBody is the minimal shape of a logged `hashedrekord` entry (apiVersion 0.0.1),
// used to confirm the log entry binds to our receipt digest + anchor signature.
type hashedRekordBody struct {
	Kind string `json:"kind"`
	Spec struct {
		Data struct {
			Hash struct {
				Algorithm string `json:"algorithm"`
				Value     string `json:"value"`
			} `json:"hash"`
		} `json:"data"`
		Signature struct {
			Content   string `json:"content"`
			PublicKey struct {
				Content string `json:"content"`
			} `json:"publicKey"`
		} `json:"signature"`
	} `json:"spec"`
}

// VerifyAnchor proves, entirely offline, that a Rekor anchor is a valid inclusion proof for the
// given receipt. logKey is the Rekor instance's log public key (ECDSA-P256), pinned by the
// deployer from the Sigstore TUF trust root (or the self-hosted instance's key) — it is a
// required input rather than a vendored constant so a wrong/rotated key can never be silently
// trusted. A nil error means: the anchor signature binds to this receipt, the logged entry
// binds to that signature, the log signed a promise of inclusion, and the Merkle audit path
// resolves to the proof's root. Any failure is fail-closed.
func VerifyAnchor(r Receipt, a *RekorAnchor, logKey *ecdsa.PublicKey) error {
	if a == nil {
		return fmt.Errorf("nil rekor anchor")
	}
	if logKey == nil {
		return fmt.Errorf("no rekor log public key supplied to verify against")
	}

	// 1. Bind the anchor signature to THIS receipt: ECDSA-P256 over sha256(canonical receipt).
	digest, err := AnchorDigest(r)
	if err != nil {
		return err
	}
	anchorPub, err := decodeECDSAPublicKeyB64PEM(a.AnchorPublicKey)
	if err != nil {
		return fmt.Errorf("anchor public key: %w", err)
	}
	anchorSig, err := base64.StdEncoding.DecodeString(a.AnchorSignature)
	if err != nil {
		return fmt.Errorf("decode anchor signature: %w", err)
	}
	if !ecdsa.VerifyASN1(anchorPub, digest, anchorSig) {
		return fmt.Errorf("anchor signature does not verify over the receipt digest (tampered, or wrong receipt)")
	}

	// 2. Bind the LOGGED entry to that signature + digest: the hashedrekord body must carry our
	//    digest, our anchor signature, and our anchor public key. This is what ties the Merkle
	//    proof (which covers the body) to our receipt.
	bodyBytes, err := base64.StdEncoding.DecodeString(a.Body)
	if err != nil {
		return fmt.Errorf("decode rekor body: %w", err)
	}
	var body hashedRekordBody
	if err := json.Unmarshal(bodyBytes, &body); err != nil {
		return fmt.Errorf("parse rekor body: %w", err)
	}
	if body.Kind != "hashedrekord" {
		return fmt.Errorf("unexpected rekor entry kind %q (want hashedrekord)", body.Kind)
	}
	if body.Spec.Data.Hash.Algorithm != "sha256" || body.Spec.Data.Hash.Value != hex.EncodeToString(digest) {
		return fmt.Errorf("logged entry hash does not match the receipt digest")
	}
	if body.Spec.Signature.Content != a.AnchorSignature {
		return fmt.Errorf("logged entry signature does not match the anchor signature")
	}
	if body.Spec.Signature.PublicKey.Content != a.AnchorPublicKey {
		return fmt.Errorf("logged entry public key does not match the anchor public key")
	}

	// 3. The log's signed promise of inclusion (the trust anchor): the SET is the log key's
	//    ECDSA signature over the canonical {body, integratedTime, logID, logIndex}.
	if a.SignedEntryTimestamp == "" {
		return fmt.Errorf("anchor has no signed entry timestamp to verify")
	}
	setSig, err := base64.StdEncoding.DecodeString(a.SignedEntryTimestamp)
	if err != nil {
		return fmt.Errorf("decode signed entry timestamp: %w", err)
	}
	setBytes := canonicalSET(a.Body, a.IntegratedTime, a.LogID, a.LogIndex)
	setDigest := sha256.Sum256(setBytes)
	if !ecdsa.VerifyASN1(logKey, setDigest[:], setSig) {
		return fmt.Errorf("signed entry timestamp does not verify under the log key (wrong log, tampered, or rotated key)")
	}

	// 4. The RFC 6962 Merkle audit path: the leaf (hash of the canonicalized body) resolves,
	//    through the proof, to the claimed root.
	leaf := rfc6962LeafHash(bodyBytes)
	root, err := hex.DecodeString(a.InclusionProof.RootHash)
	if err != nil {
		return fmt.Errorf("decode inclusion root hash: %w", err)
	}
	if err := verifyInclusion(a.InclusionProof.LogIndex, a.InclusionProof.TreeSize, leaf, a.InclusionProof.Hashes, root); err != nil {
		return fmt.Errorf("inclusion proof: %w", err)
	}

	// 5. Checkpoint consistency (defense in depth; full note-signature + consistency proofs are
	//    the monitor/witness follow-on). If a checkpoint is present, its tree size + root hash
	//    must agree with the verified inclusion proof.
	if cp := a.InclusionProof.Checkpoint; cp != "" {
		size, cpRoot, err := parseCheckpoint(cp)
		if err != nil {
			return fmt.Errorf("checkpoint: %w", err)
		}
		if size != a.InclusionProof.TreeSize || !bytes.Equal(cpRoot, root) {
			return fmt.Errorf("checkpoint tree head does not match the inclusion proof")
		}
	}

	return nil
}

// canonicalSET builds the RFC 8785-canonical JSON the Rekor SET is computed over: the four
// fields body, integratedTime, logID, logIndex in sorted-key order with no whitespace. The
// values are a base64 string, an integer, a hex string, and an integer — none require escaping
// beyond standard JSON string quoting, so this construction is byte-identical to a canonical
// JSON serializer for these inputs.
func canonicalSET(body string, integratedTime int64, logID string, logIndex int64) []byte {
	return []byte(fmt.Sprintf(`{"body":%q,"integratedTime":%d,"logID":%q,"logIndex":%d}`,
		body, integratedTime, logID, logIndex))
}

// rfc6962LeafHash returns SHA-256(0x00 || leaf) — the RFC 6962 leaf hash.
func rfc6962LeafHash(leaf []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(leaf)
	return h.Sum(nil)
}

// rfc6962NodeHash returns SHA-256(0x01 || left || right) — the RFC 6962 interior node hash.
func rfc6962NodeHash(left, right []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(left)
	h.Write(right)
	return h.Sum(nil)
}

// verifyInclusion checks an RFC 6962 inclusion proof: that leafHash at position index in a tree
// of treeSize leaves, combined with the audit-path hashes, produces root. Implements the
// canonical transparency-dev/merkle proof-chaining (decompose into inner + border, chain each).
func verifyInclusion(index, treeSize int64, leafHash []byte, hashesHex []string, root []byte) error {
	if index < 0 || treeSize < 0 {
		return fmt.Errorf("negative index or tree size")
	}
	if index >= treeSize {
		return fmt.Errorf("index %d out of range for tree size %d", index, treeSize)
	}
	proof := make([][]byte, 0, len(hashesHex))
	for i, hx := range hashesHex {
		b, err := hex.DecodeString(hx)
		if err != nil {
			return fmt.Errorf("decode audit hash %d: %w", i, err)
		}
		if len(b) != sha256.Size {
			return fmt.Errorf("audit hash %d has length %d, want %d", i, len(b), sha256.Size)
		}
		proof = append(proof, b)
	}

	idx, size := uint64(index), uint64(treeSize)
	inner := bits.Len64(idx ^ (size - 1)) // depth at which index and (size-1) paths diverge
	border := bits.OnesCount64(idx >> uint(inner))
	if len(proof) != inner+border {
		return fmt.Errorf("proof has %d hashes, want %d (inner %d + border %d)", len(proof), inner+border, inner, border)
	}

	res := leafHash
	// chainInner: fold the first `inner` siblings, orienting by the index bit at each level.
	for i := 0; i < inner; i++ {
		if (idx>>uint(i))&1 == 0 {
			res = rfc6962NodeHash(res, proof[i])
		} else {
			res = rfc6962NodeHash(proof[i], res)
		}
	}
	// chainBorderRight: fold the remaining `border` siblings, always on the left.
	for i := inner; i < len(proof); i++ {
		res = rfc6962NodeHash(proof[i], res)
	}

	if !bytes.Equal(res, root) {
		return fmt.Errorf("computed root does not match claimed root (inclusion proof invalid)")
	}
	return nil
}

// parseCheckpoint extracts the tree size and root hash from a Rekor signed checkpoint (a signed
// note). The note body is: origin line, tree size (decimal), base64(root hash), then optional
// lines, a blank line, and signature line(s). We read only the size + root here (the note
// signature verification + cross-checkpoint consistency is the monitor follow-on).
func parseCheckpoint(checkpoint string) (treeSize int64, rootHash []byte, err error) {
	// The signed note body is everything before the "\n\n" that precedes the signature block.
	body := checkpoint
	if i := bytes.Index([]byte(checkpoint), []byte("\n\n")); i >= 0 {
		body = checkpoint[:i]
	}
	lines := bytes.Split([]byte(body), []byte("\n"))
	if len(lines) < 3 {
		return 0, nil, fmt.Errorf("malformed checkpoint: want at least origin, size, root")
	}
	if _, err := fmt.Sscanf(string(lines[1]), "%d", &treeSize); err != nil {
		return 0, nil, fmt.Errorf("malformed checkpoint tree size: %w", err)
	}
	rootHash, err = base64.StdEncoding.DecodeString(string(lines[2]))
	if err != nil {
		return 0, nil, fmt.Errorf("malformed checkpoint root hash: %w", err)
	}
	return treeSize, rootHash, nil
}

// decodeECDSAPublicKeyB64PEM decodes base64(std) of a PEM-encoded (PKIX) ECDSA public key — the
// exact encoding stored on the anchor and logged as the hashedrekord public key.
func decodeECDSAPublicKeyB64PEM(b64 string) (*ecdsa.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("not valid base64: %w", err)
	}
	block, _ := pem.Decode(der)
	if block == nil {
		return nil, fmt.Errorf("not PEM-encoded")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKIX public key: %w", err)
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is not ECDSA")
	}
	return ec, nil
}

// ParseRekorLogKey parses a PEM-encoded ECDSA-P256 Rekor log public key (the deployer-pinned
// key VerifyAnchor checks the SET against).
func ParseRekorLogKey(pemBytes []byte) (*ecdsa.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("rekor log key: not PEM-encoded")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("rekor log key: parse PKIX: %w", err)
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("rekor log key: not ECDSA")
	}
	return ec, nil
}
