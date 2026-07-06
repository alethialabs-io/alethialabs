// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
	"time"
)

// genKey returns a deterministic-enough ed25519 keypair for tests.
func genKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return pub, priv
}

func sampleReceipt(t *testing.T) Receipt {
	t.Helper()
	rep := evalFixture(t, "pass_keyless_least_priv.json")
	return BuildReceipt(BuildReceiptParams{
		Report:           rep,
		PlanBytes:        []byte("a fake plan file's bytes"),
		TofuVersion:      "1.9.0",
		ProviderVersions: map[string]string{"aws": "5.60.0"},
		Runner:           "runner-test",
		EvaluatedAt:      "2026-06-29T12:00:00Z",
	})
}

func TestPlanSHA256(t *testing.T) {
	if got := PlanSHA256(nil); got != "" {
		t.Errorf("empty plan should hash to empty string, got %q", got)
	}
	a := PlanSHA256([]byte("x"))
	b := PlanSHA256([]byte("x"))
	if a != b {
		t.Errorf("hash not deterministic: %q != %q", a, b)
	}
	if a == PlanSHA256([]byte("y")) {
		t.Error("different inputs must hash differently")
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv := genKey(t)
	r := sampleReceipt(t)
	signed, err := Sign(r, priv, KeyID(pub))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if signed.Algorithm != "ed25519" || signed.Signature == "" {
		t.Fatalf("unexpected signed receipt: %+v", signed)
	}
	if err := signed.Verify(pub); err != nil {
		t.Fatalf("verify of a freshly signed receipt should succeed: %v", err)
	}
}

func TestTamperInReceiptBreaksSignature(t *testing.T) {
	pub, priv := genKey(t)
	signed, err := Sign(sampleReceipt(t), priv, KeyID(pub))
	if err != nil {
		t.Fatal(err)
	}
	// Flip the verdict after signing — the classic "say it passed" tamper.
	signed.Receipt.Verdict = StatusPass
	signed.Receipt.PlanSHA256 = PlanSHA256([]byte("a different plan entirely"))
	if err := signed.Verify(pub); err == nil {
		t.Fatal("verify must fail after the receipt body is altered")
	}
}

func TestTamperInSignatureBreaksVerify(t *testing.T) {
	pub, priv := genKey(t)
	signed, err := Sign(sampleReceipt(t), priv, KeyID(pub))
	if err != nil {
		t.Fatal(err)
	}
	// Corrupt one byte of the signature.
	raw, _ := base64.StdEncoding.DecodeString(signed.Signature)
	raw[0] ^= 0xFF
	signed.Signature = base64.StdEncoding.EncodeToString(raw)
	if err := signed.Verify(pub); err == nil {
		t.Fatal("verify must fail when the signature is corrupted")
	}
}

func TestVerifyWithWrongKeyFails(t *testing.T) {
	_, priv := genKey(t)
	otherPub, _ := genKey(t)
	signed, err := Sign(sampleReceipt(t), priv, "kid")
	if err != nil {
		t.Fatal(err)
	}
	if err := signed.Verify(otherPub); err == nil {
		t.Fatal("verify must fail under a different public key")
	}
}

func TestBuildReceiptRecordsException(t *testing.T) {
	rep := evalFixture(t, "fail_static_key_admin.json")
	ov := &Override{
		Controls: []string{"KEYLESS-001", "LEASTPRIV-001"},
		Reason:   "migration window",
		By:       "secops@acme",
		Expiry:   time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
	}
	r := BuildReceipt(BuildReceiptParams{Report: rep, Override: ov, PlanBytes: []byte("p")})
	if r.Exception == nil {
		t.Fatal("an applied override must be recorded as an exception in the receipt")
	}
	if r.Exception.By != "secops@acme" || len(r.Exception.Controls) != 2 || r.Exception.Expiry == "" {
		t.Errorf("exception not recorded faithfully: %+v", r.Exception)
	}
	// The receipt still carries the true (failing) verdict — the exception explains
	// why the apply was allowed, it does not rewrite the verdict to pass.
	if r.Verdict != StatusFail {
		t.Errorf("verdict should remain %q with an exception, got %q", StatusFail, r.Verdict)
	}
}

func TestSigningKeyFromEnv(t *testing.T) {
	_, priv := genKey(t)
	t.Setenv(SigningKeyEnv, base64.StdEncoding.EncodeToString(priv))
	got, keyID, ok, err := SigningKeyFromEnv()
	if err != nil || !ok {
		t.Fatalf("expected a key from env, got ok=%v err=%v", ok, err)
	}
	if keyID == "" || len(got) != ed25519.PrivateKeySize {
		t.Fatalf("bad key load: keyID=%q len=%d", keyID, len(got))
	}
	// Round-trip a signature with the loaded key.
	signed, err := Sign(sampleReceipt(t), got, keyID)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := priv.Public().(ed25519.PublicKey)
	if err := signed.Verify(pub); err != nil {
		t.Fatalf("env-loaded key should verify: %v", err)
	}
}

func TestSigningKeyFromEnvUnset(t *testing.T) {
	t.Setenv(SigningKeyEnv, "")
	_, _, ok, err := SigningKeyFromEnv()
	if ok || err != nil {
		t.Fatalf("unset key should be ok=false err=nil, got ok=%v err=%v", ok, err)
	}
}

func TestSigningKeyFromEnvInvalid(t *testing.T) {
	t.Setenv(SigningKeyEnv, "not-base64!!!")
	if _, _, _, err := SigningKeyFromEnv(); err == nil {
		t.Fatal("invalid base64 key must error")
	}
}
