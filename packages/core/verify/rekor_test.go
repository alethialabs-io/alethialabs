// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"testing"
)

// buildTestAnchor assembles a fully valid RekorAnchor for a receipt against a synthetic log +
// anchor key, standing in for a real Rekor v1 response. The entry is placed at `index` in a
// two-leaf tree so the RFC 6962 inclusion proof is exercised for real. Returns the anchor and
// the log public key VerifyAnchor is meant to be called with.
func buildTestAnchor(t *testing.T, r Receipt, index int64) (*RekorAnchor, *ecdsa.PublicKey) {
	t.Helper()

	logPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen log key: %v", err)
	}
	anchorPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen anchor key: %v", err)
	}

	// The anchor signature: ECDSA-P256 over sha256(canonical receipt).
	digest, err := AnchorDigest(r)
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	anchorSig, err := ecdsa.SignASN1(rand.Reader, anchorPriv, digest)
	if err != nil {
		t.Fatalf("anchor sign: %v", err)
	}
	anchorPubPEM := marshalPubPEM(t, &anchorPriv.PublicKey)
	anchorPubB64 := base64.StdEncoding.EncodeToString(anchorPubPEM)
	anchorSigB64 := base64.StdEncoding.EncodeToString(anchorSig)

	// The logged hashedrekord entry body (hash-only) binding to our digest + anchor sig.
	body := map[string]any{
		"kind":       "hashedrekord",
		"apiVersion": "0.0.1",
		"spec": map[string]any{
			"data": map[string]any{
				"hash": map[string]any{"algorithm": "sha256", "value": hex.EncodeToString(digest)},
			},
			"signature": map[string]any{
				"content":   anchorSigB64,
				"publicKey": map[string]any{"content": anchorPubB64},
			},
		},
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	bodyB64 := base64.StdEncoding.EncodeToString(bodyBytes)

	// A two-leaf Merkle tree with our entry at `index` (the other leaf is arbitrary).
	ourLeaf := rfc6962LeafHash(bodyBytes)
	otherLeaf := rfc6962LeafHash([]byte("sibling-entry"))
	var root []byte
	var proofHashes []string
	if index == 0 {
		root = rfc6962NodeHash(ourLeaf, otherLeaf)
		proofHashes = []string{hex.EncodeToString(otherLeaf)}
	} else {
		root = rfc6962NodeHash(otherLeaf, ourLeaf)
		proofHashes = []string{hex.EncodeToString(otherLeaf)}
	}
	rootHex := hex.EncodeToString(root)

	// logID = hex(sha256(DER log pubkey)).
	logDER, err := x509.MarshalPKIXPublicKey(&logPriv.PublicKey)
	if err != nil {
		t.Fatalf("marshal log key: %v", err)
	}
	logIDSum := sha256.Sum256(logDER)
	logID := hex.EncodeToString(logIDSum[:])

	const integratedTime int64 = 1_700_000_000

	// SET: log-key ECDSA over sha256(canonical {body, integratedTime, logID, logIndex}).
	setBytes := canonicalSET(bodyB64, integratedTime, logID, index)
	setDigest := sha256.Sum256(setBytes)
	set, err := ecdsa.SignASN1(rand.Reader, logPriv, setDigest[:])
	if err != nil {
		t.Fatalf("SET sign: %v", err)
	}

	// A signed-note-shaped checkpoint whose tree head matches the proof (signature is not the
	// trust anchor for #885; only size + root are cross-checked).
	checkpoint := fmt.Sprintf("rekor.test\n%d\n%s\n\n— rekor.test %s\n",
		int64(2), base64.StdEncoding.EncodeToString(root), base64.StdEncoding.EncodeToString([]byte("sig")))

	anchor := &RekorAnchor{
		LogURL:               "https://rekor.test",
		LogID:                logID,
		LogIndex:             index,
		IntegratedTime:       integratedTime,
		Body:                 bodyB64,
		SignedEntryTimestamp: base64.StdEncoding.EncodeToString(set),
		AnchorAlgorithm:      "ecdsa-p256-sha256",
		AnchorSignature:      anchorSigB64,
		AnchorPublicKey:      anchorPubB64,
		InclusionProof: RekorInclusionProof{
			LogIndex:   index,
			RootHash:   rootHex,
			TreeSize:   2,
			Hashes:     proofHashes,
			Checkpoint: checkpoint,
		},
	}
	return anchor, &logPriv.PublicKey
}

func marshalPubPEM(t *testing.T, pub *ecdsa.PublicKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("marshal pub: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
}

func testReceipt() Receipt {
	return Receipt{
		Version:        ReceiptVersion,
		PlanSHA256:     "abc123",
		CatalogVersion: CatalogVersion,
		Provider:       "aws",
		Verdict:        StatusPass,
		EvaluatedAt:    "2026-07-21T00:00:00Z",
	}
}

func TestVerifyAnchor_Valid(t *testing.T) {
	for _, index := range []int64{0, 1} {
		r := testReceipt()
		anchor, logKey := buildTestAnchor(t, r, index)
		if err := VerifyAnchor(r, anchor, logKey); err != nil {
			t.Fatalf("index %d: expected valid anchor, got %v", index, err)
		}
	}
}

func TestVerifyAnchor_RejectsTamperedReceipt(t *testing.T) {
	r := testReceipt()
	anchor, logKey := buildTestAnchor(t, r, 0)

	// Same anchor, different receipt → the anchor signature no longer binds.
	tampered := r
	tampered.PlanSHA256 = "deadbeef"
	if err := VerifyAnchor(tampered, anchor, logKey); err == nil {
		t.Fatal("expected verification to fail for a tampered receipt, got nil")
	}
}

func TestVerifyAnchor_RejectsTamperedProof(t *testing.T) {
	r := testReceipt()

	cases := map[string]func(a *RekorAnchor){
		"flipped audit hash": func(a *RekorAnchor) {
			a.InclusionProof.Hashes = []string{hex.EncodeToString(make([]byte, sha256.Size))}
		},
		"wrong root": func(a *RekorAnchor) {
			a.InclusionProof.RootHash = hex.EncodeToString(make([]byte, sha256.Size))
		},
		"forged SET": func(a *RekorAnchor) {
			a.SignedEntryTimestamp = base64.StdEncoding.EncodeToString([]byte("not-a-signature"))
		},
		"body digest mismatch": func(a *RekorAnchor) {
			// Re-log a hashedrekord for a different digest but keep the real anchor sig fields.
			a.Body = base64.StdEncoding.EncodeToString([]byte(`{"kind":"hashedrekord","spec":{"data":{"hash":{"algorithm":"sha256","value":"00"}},"signature":{"content":"x","publicKey":{"content":"y"}}}}`))
		},
		"checkpoint mismatch": func(a *RekorAnchor) {
			a.InclusionProof.Checkpoint = "rekor.test\n99\n" + base64.StdEncoding.EncodeToString(make([]byte, sha256.Size)) + "\n\n— rekor.test c2ln\n"
		},
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			anchor, logKey := buildTestAnchor(t, r, 0)
			mutate(anchor)
			if err := VerifyAnchor(r, anchor, logKey); err == nil {
				t.Fatalf("%s: expected verification to fail, got nil", name)
			}
		})
	}
}

func TestVerifyAnchor_RejectsWrongLogKey(t *testing.T) {
	r := testReceipt()
	anchor, _ := buildTestAnchor(t, r, 0)
	otherLog, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	if err := VerifyAnchor(r, anchor, &otherLog.PublicKey); err == nil {
		t.Fatal("expected verification to fail under an unrelated log key, got nil")
	}
}

func TestVerifyAnchor_NilInputs(t *testing.T) {
	r := testReceipt()
	if err := VerifyAnchor(r, nil, nil); err == nil {
		t.Fatal("expected error for nil anchor")
	}
	anchor, _ := buildTestAnchor(t, r, 0)
	if err := VerifyAnchor(r, anchor, nil); err == nil {
		t.Fatal("expected error for nil log key")
	}
}
