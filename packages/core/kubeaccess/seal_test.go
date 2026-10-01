// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"bytes"
	"crypto/hpke"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	testMint    = "3f1c9a52-7d4e-4b8a-9c21-6e0f5a7b8c9d"
	testCluster = "b2e4f6a8-1c3d-4e5f-8a9b-0c1d2e3f4a5b"
	otherID     = "00000000-0000-4000-8000-000000000001"
)

// sealVectors mirrors testdata/seal_vectors.json.
type sealVectors struct {
	RFC9180 struct {
		Mode           int    `json:"mode"`
		KEMID          uint16 `json:"kem_id"`
		KDFID          uint16 `json:"kdf_id"`
		AEADID         uint16 `json:"aead_id"`
		Info           string `json:"info"`
		IkmR           string `json:"ikmR"`
		SkRm           string `json:"skRm"`
		PkRm           string `json:"pkRm"`
		Enc            string `json:"enc"`
		ExporterSecret string `json:"exporter_secret"`
		Encryptions    []struct {
			AAD   string `json:"aad"`
			CT    string `json:"ct"`
			Nonce string `json:"nonce"`
			PT    string `json:"pt"`
		} `json:"encryptions"`
		Exports []struct {
			Context string `json:"exporter_context"`
			L       int    `json:"L"`
			Value   string `json:"exported_value"`
		} `json:"exports"`
	} `json:"rfc9180"`
	Mint struct {
		Info         string `json:"info"`
		RecipientIKM string `json:"recipient_ikm_hex"`
		RecipientSK  string `json:"recipient_sk_hex"`
		RecipientPK  string `json:"recipient_pk_b64url"`
		MintID       string `json:"mint_id"`
		ClusterID    string `json:"cluster_id"`
		AADHex       string `json:"aad_hex"`
		Sealed       string `json:"sealed_b64url"`
		Plaintext    string `json:"plaintext"`
	} `json:"alethia_mint"`
}

// loadVectors reads the published vector file.
func loadVectors(t *testing.T) sealVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "seal_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v sealVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// unhex decodes a hex string or fails the test.
func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestSuiteIsTheDecidedOne pins the suite by its RFC 9180 identifiers, written out — not read back
// from suite() — so swapping a component is a visible change to a decision.
func TestSuiteIsTheDecidedOne(t *testing.T) {
	kem, kdf, aead := suite()
	if kem.ID() != 0x0020 || kdf.ID() != 0x0001 || aead.ID() != 0x0002 {
		t.Fatalf("suite is kem %04x kdf %04x aead %04x, want 0020/0001/0002", kem.ID(), kdf.ID(), aead.ID())
	}
	v := loadVectors(t).RFC9180
	if v.Mode != 0 || v.KEMID != kem.ID() || v.KDFID != kdf.ID() || v.AEADID != aead.ID() {
		t.Fatalf("the published vector is not for this suite: %+v", v)
	}
}

// TestRFC9180Vector opens the RFC 9180 base-mode vector for DHKEM(X25519, HKDF-SHA256) /
// HKDF-SHA256 / AES-256-GCM through openWith — the exact path ClientKey.Open takes — and checks the
// key derivation and key schedule against the vector too.
func TestRFC9180Vector(t *testing.T) {
	v := loadVectors(t).RFC9180
	kem, kdf, aead := suite()

	derived, err := kem.DeriveKeyPair(unhex(t, v.IkmR))
	if err != nil {
		t.Fatal(err)
	}
	if got := derived.PublicKey().Bytes(); !bytes.Equal(got, unhex(t, v.PkRm)) {
		t.Fatalf("DeriveKeyPair(ikmR) public key = %x, want pkRm %x", got, v.PkRm)
	}
	priv, err := kem.NewPrivateKey(unhex(t, v.SkRm))
	if err != nil {
		t.Fatal(err)
	}

	// Sequence 0 is the only one a single-shot seal ever uses.
	e := v.Encryptions[0]
	blob := append(unhex(t, v.Enc), unhex(t, e.CT)...)
	pt, err := openWith(priv, unhex(t, v.Info), unhex(t, e.AAD), blob)
	if err != nil {
		t.Fatalf("the RFC 9180 vector does not open: %v", err)
	}
	if !bytes.Equal(pt, unhex(t, e.PT)) {
		t.Fatalf("opened %x, want %x", pt, e.PT)
	}

	// The exporter proves the key schedule (shared secret → secret → exporter_secret) independently
	// of the AEAD.
	r, err := hpke.NewRecipient(unhex(t, v.Enc), priv, kdf, aead, unhex(t, v.Info))
	if err != nil {
		t.Fatal(err)
	}
	x := v.Exports[0]
	got, err := r.Export(x.Context, x.L)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, unhex(t, x.Value)) {
		t.Fatalf("export = %x, want %s", got, x.Value)
	}
}

// TestAlethiaMintVector opens the frozen Alethia-construction blob, so the AAD and wire framing
// cannot change without the published vector — which the browser implementation checks — failing.
func TestAlethiaMintVector(t *testing.T) {
	v := loadVectors(t).Mint
	if v.Info != SealInfo {
		t.Fatalf("published info %q, SealInfo %q", v.Info, SealInfo)
	}
	aad, err := MintAAD(v.MintID, v.ClusterID)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(aad) != v.AADHex {
		t.Fatalf("MintAAD = %x, published %s", aad, v.AADHex)
	}
	kem, _, _ := suite()
	priv, err := kem.DeriveKeyPair(unhex(t, v.RecipientIKM))
	if err != nil {
		t.Fatal(err)
	}
	k := &ClientKey{priv: priv}
	if k.PublicKey() != v.RecipientPK {
		t.Fatalf("recipient public key %s, published %s", k.PublicKey(), v.RecipientPK)
	}
	sk, err := priv.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(sk) != v.RecipientSK {
		t.Fatalf("recipient sk %x, published %s", sk, v.RecipientSK)
	}
	pt, err := k.Open(v.Sealed, v.MintID, v.ClusterID)
	if err != nil {
		t.Fatalf("the published Alethia vector does not open: %v", err)
	}
	if string(pt) != v.Plaintext {
		t.Fatalf("opened %q, want %q", pt, v.Plaintext)
	}
	var cred types.KubeconfigMintCredential
	if err := json.Unmarshal(pt, &cred); err != nil {
		t.Fatal(err)
	}
	if err := cred.Validate(); err != nil {
		t.Fatalf("the vector's plaintext is not a valid credential: %v", err)
	}
}

// TestMintAAD_Literal pins the AAD bytes as a literal: info, NUL, mint id, NUL, cluster id.
func TestMintAAD_Literal(t *testing.T) {
	aad, err := MintAAD(testMint, testCluster)
	if err != nil {
		t.Fatal(err)
	}
	want := "alethia/kubeconfig-mint/v1\x00" + testMint + "\x00" + testCluster
	if string(aad) != want {
		t.Fatalf("aad = %q, want %q", aad, want)
	}
	for _, bad := range []string{strings.ToUpper(testMint), "{" + testMint + "}", strings.ReplaceAll(testMint, "-", ""), "", "not-a-uuid"} {
		if _, err := MintAAD(bad, testCluster); !errors.Is(err, ErrSeal) {
			t.Errorf("mint id %q accepted", bad)
		}
		if _, err := MintAAD(testMint, bad); !errors.Is(err, ErrSeal) {
			t.Errorf("cluster id %q accepted", bad)
		}
	}
}

// TestSealOpen_RoundTrip is the runner→client path with a fresh client key.
func TestSealOpen_RoundTrip(t *testing.T) {
	k, err := GenerateClientKey()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := types.DecodeKubeconfigMintPublicKey(k.PublicKey()); err != nil {
		t.Fatalf("the client key's wire form is refused by the contract: %v", err)
	}
	pt := []byte(`{"shape":"exec","tier":"readonly"}`)
	sealed, err := Seal(k.PublicKey(), testMint, testCluster, pt)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains([]byte(sealed), pt) {
		t.Fatal("the sealed form contains the plaintext")
	}
	got, err := k.Open(sealed, testMint, testCluster)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, pt) {
		t.Fatalf("round trip = %q, want %q", got, pt)
	}
	// Two seals of the same plaintext differ (fresh ephemeral key each time).
	again, err := Seal(k.PublicKey(), testMint, testCluster, pt)
	if err != nil {
		t.Fatal(err)
	}
	if again == sealed {
		t.Fatal("two seals are identical: the ephemeral key is not fresh")
	}
}

// TestOpen_RefusesReplayAndTamper is the binding: a blob opens only for the key, mint and cluster it
// was sealed for, and not at all once altered.
func TestOpen_RefusesReplayAndTamper(t *testing.T) {
	k, err := GenerateClientKey()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := Seal(k.PublicKey(), testMint, testCluster, []byte("credential"))
	if err != nil {
		t.Fatal(err)
	}
	other, err := GenerateClientKey()
	if err != nil {
		t.Fatal(err)
	}
	tampered := []byte(sealed)
	// Flip a character inside the ciphertext (past the 43-char enc), keeping the alphabet valid.
	if tampered[60] == 'A' {
		tampered[60] = 'B'
	} else {
		tampered[60] = 'A'
	}

	cases := map[string]func() ([]byte, error){
		"another mint id":         func() ([]byte, error) { return k.Open(sealed, otherID, testCluster) },
		"another cluster id":      func() ([]byte, error) { return k.Open(sealed, testMint, otherID) },
		"ids swapped":             func() ([]byte, error) { return k.Open(sealed, testCluster, testMint) },
		"another client key":      func() ([]byte, error) { return other.Open(sealed, testMint, testCluster) },
		"a tampered ciphertext":   func() ([]byte, error) { return k.Open(string(tampered), testMint, testCluster) },
		"a truncated blob":        func() ([]byte, error) { return k.Open(sealed[:40], testMint, testCluster) },
		"padded base64":           func() ([]byte, error) { return k.Open(sealed+"=", testMint, testCluster) },
		"an empty sealed payload": func() ([]byte, error) { return k.Open("", testMint, testCluster) },
	}
	for name, open := range cases {
		pt, err := open()
		if !errors.Is(err, ErrSeal) || pt != nil {
			t.Errorf("%s: want ErrSeal and no plaintext, got %q, %v", name, pt, err)
		}
	}
}

// TestSeal_RefusesBadInput covers the runner-side refusals.
func TestSeal_RefusesBadInput(t *testing.T) {
	k, err := GenerateClientKey()
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]func() (string, error){
		"a malformed key": func() (string, error) { return Seal("not-a-key", testMint, testCluster, []byte("x")) },
		"a non-canonical mint": func() (string, error) {
			return Seal(k.PublicKey(), strings.ToUpper(testMint), testCluster, []byte("x"))
		},
		"an oversized result": func() (string, error) {
			return Seal(k.PublicKey(), testMint, testCluster, make([]byte, types.KubeconfigMintSealedMaxLength))
		},
	}
	for name, seal := range cases {
		out, err := seal()
		if !errors.Is(err, ErrSeal) || out != "" {
			t.Errorf("%s: want ErrSeal and no output, got %q, %v", name, out, err)
		}
	}
	// The all-zero point is a valid encoding but a low-order X25519 key; the KEM must refuse it.
	zero := strings.Repeat("A", 43)
	if out, err := Seal(zero, testMint, testCluster, []byte("x")); !errors.Is(err, ErrSeal) || out != "" {
		t.Errorf("sealed to the all-zero X25519 point: %q, %v", out, err)
	}
}

// TestOpen_RefusesBadFraming covers the client-side refusals that never reach the AEAD: an id the
// AAD will not bind, and an `enc` that is the all-zero (low-order) point.
func TestOpen_RefusesBadFraming(t *testing.T) {
	k, err := GenerateClientKey()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := Seal(k.PublicKey(), testMint, testCluster, []byte("credential"))
	if err != nil {
		t.Fatal(err)
	}
	if pt, err := k.Open(sealed, strings.ToUpper(testMint), testCluster); !errors.Is(err, ErrSeal) || pt != nil {
		t.Errorf("non-canonical mint id: got %q, %v", pt, err)
	}
	blob, err := b64.DecodeString(sealed)
	if err != nil {
		t.Fatal(err)
	}
	copy(blob[:encLen], make([]byte, encLen))
	if pt, err := k.Open(b64.EncodeToString(blob), testMint, testCluster); !errors.Is(err, ErrSeal) || pt != nil {
		t.Errorf("all-zero enc: got %q, %v", pt, err)
	}
}
