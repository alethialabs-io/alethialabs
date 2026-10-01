// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// The RFC 9180 suite vector's recipient key (pkRm), base64url — a real 32-byte X25519 key.
const testMintKey = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw"

// TestKubeconfigMintBounds pins the #5250 §2 decisions as literals, so a change to a constant is a
// change to a decision and has to be made here too. The console pins the same numbers.
func TestKubeconfigMintBounds(t *testing.T) {
	if KubeconfigMintTTLDefaultSeconds != 3600 || KubeconfigMintTTLMaxSeconds != 8*3600 || KubeconfigMintTTLMinSeconds != 15*60 {
		t.Fatalf("TTL bounds drifted: min %d default %d max %d", KubeconfigMintTTLMinSeconds, KubeconfigMintTTLDefaultSeconds, KubeconfigMintTTLMaxSeconds)
	}
	for ttl, ok := range map[int]bool{899: false, 900: true, 3600: true, 28_800: true, 28_801: false} {
		if got := ValidateKubeconfigMintTTL(ttl) == nil; got != ok {
			t.Errorf("ttl %d: valid=%v, want %v", ttl, got, ok)
		}
	}
}

// TestKubeconfigMintRequest_Validate drives every refusal and the accepting case.
func TestKubeconfigMintRequest_Validate(t *testing.T) {
	good := KubeconfigMintRequest{Tier: KubeconfigMintTierReadonly, TTLSeconds: 3600, Shape: KubeconfigMintShapeExec, ClientPublicKey: testMintKey}
	if err := good.Validate(); err != nil {
		t.Fatalf("a well-formed request was refused: %v", err)
	}
	bad := map[string]KubeconfigMintRequest{
		"unknown tier":      {Tier: "root", TTLSeconds: 3600, Shape: KubeconfigMintShapeExec, ClientPublicKey: testMintKey},
		"unknown shape":     {Tier: KubeconfigMintTierAdmin, TTLSeconds: 3600, Shape: "file", ClientPublicKey: testMintKey},
		"ttl over 8h":       {Tier: KubeconfigMintTierAdmin, TTLSeconds: 28_801, Shape: KubeconfigMintShapeStatic, ClientPublicKey: testMintKey},
		"padded key":        {Tier: KubeconfigMintTierAdmin, TTLSeconds: 3600, Shape: KubeconfigMintShapeStatic, ClientPublicKey: testMintKey + "="},
		"short key":         {Tier: KubeconfigMintTierAdmin, TTLSeconds: 3600, Shape: KubeconfigMintShapeStatic, ClientPublicKey: testMintKey[:40]},
		"std alphabet key":  {Tier: KubeconfigMintTierAdmin, TTLSeconds: 3600, Shape: KubeconfigMintShapeStatic, ClientPublicKey: testMintKey[:42] + "+"},
		"non-canonical key": {Tier: KubeconfigMintTierAdmin, TTLSeconds: 3600, Shape: KubeconfigMintShapeStatic, ClientPublicKey: testMintKey[:42] + "x"},
	}
	for name, req := range bad {
		if err := req.Validate(); !errors.Is(err, ErrKubeconfigMintInvalid) {
			t.Errorf("%s: want ErrKubeconfigMintInvalid, got %v", name, err)
		}
	}
}

// TestRunnerKubeconfigMintResult_Validate pins that a runner can post ciphertext or a bounded
// reason and nothing else.
func TestRunnerKubeconfigMintResult_Validate(t *testing.T) {
	f := false
	ok := []RunnerKubeconfigMintResult{
		{Status: KubeconfigMintStatusReady, MintID: "m", Sealed: "abc", PrivateEndpoint: &f},
		{Status: KubeconfigMintStatusFailed, MintID: "m", Reason: "unreachable"},
	}
	for _, r := range ok {
		if err := r.Validate(); err != nil {
			t.Errorf("%+v refused: %v", r, err)
		}
	}
	bad := []RunnerKubeconfigMintResult{
		{Status: KubeconfigMintStatusReady, MintID: "m", PrivateEndpoint: &f},
		{Status: KubeconfigMintStatusReady, MintID: "m", Sealed: "abc"},
		{Status: KubeconfigMintStatusReady, MintID: "m", Sealed: strings.Repeat("A", KubeconfigMintSealedMaxLength+1), PrivateEndpoint: &f},
		{Status: KubeconfigMintStatusFailed, MintID: "m", Reason: strings.Repeat("x", KubeconfigMintFailureReasonMaxLength+1)},
		{Status: KubeconfigMintStatusFailed, MintID: "m", Reason: "r", Sealed: "abc"},
		{Status: KubeconfigMintStatusPending, MintID: "m"},
		{Status: KubeconfigMintStatusExpired, MintID: "m"},
		{Status: KubeconfigMintStatusReady, Sealed: "abc", PrivateEndpoint: &f},
	}
	for _, r := range bad {
		if err := r.Validate(); !errors.Is(err, ErrKubeconfigMintInvalid) {
			t.Errorf("%+v: want ErrKubeconfigMintInvalid, got %v", r, err)
		}
	}
}

// TestKubeconfigMintPollResponse_Validate pins what each poll state may carry.
func TestKubeconfigMintPollResponse_Validate(t *testing.T) {
	tr := true
	ok := []KubeconfigMintPollResponse{
		{Status: KubeconfigMintStatusPending},
		{Status: KubeconfigMintStatusReady, Sealed: "abc", PrivateEndpoint: &tr},
		{Status: KubeconfigMintStatusFailed, Reason: "r"},
		{Status: KubeconfigMintStatusExpired},
	}
	for _, p := range ok {
		if err := p.Validate(); err != nil {
			t.Errorf("%+v refused: %v", p, err)
		}
	}
	bad := []KubeconfigMintPollResponse{
		{Status: KubeconfigMintStatusPending, Sealed: "abc"},
		{Status: KubeconfigMintStatusReady, PrivateEndpoint: &tr},
		{Status: KubeconfigMintStatusReady, Sealed: "abc"},
		{Status: KubeconfigMintStatusFailed},
		{Status: KubeconfigMintStatusExpired, Sealed: "abc"},
		{Status: "consumed"},
	}
	for _, p := range bad {
		if err := p.Validate(); !errors.Is(err, ErrKubeconfigMintInvalid) {
			t.Errorf("%+v: want ErrKubeconfigMintInvalid, got %v", p, err)
		}
	}
}

// TestKubeconfigMintCredential_Validate pins that exec and static never mix.
func TestKubeconfigMintCredential_Validate(t *testing.T) {
	exp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	exec := KubeconfigMintCredential{Shape: KubeconfigMintShapeExec, Tier: KubeconfigMintTierReadonly, Server: "https://k", CertificateAuthorityData: "Q0E=", Token: "t", ExpiresAt: exp}
	static := KubeconfigMintCredential{Shape: KubeconfigMintShapeStatic, Tier: KubeconfigMintTierAdmin, Kubeconfig: "apiVersion: v1", ExpiresAt: exp}
	for _, c := range []KubeconfigMintCredential{exec, static} {
		if err := c.Validate(); err != nil {
			t.Errorf("%s refused: %v", c.Shape, err)
		}
	}
	mixed := exec
	mixed.Kubeconfig = "apiVersion: v1"
	noExpiry := static
	noExpiry.ExpiresAt = time.Time{}
	staticWithToken := static
	staticWithToken.Token = "t"
	for name, c := range map[string]KubeconfigMintCredential{"exec+kubeconfig": mixed, "no expiry": noExpiry, "static+token": staticWithToken} {
		if err := c.Validate(); !errors.Is(err, ErrKubeconfigMintInvalid) {
			t.Errorf("%s: want ErrKubeconfigMintInvalid, got %v", name, err)
		}
	}
}

// TestRunnerKubeconfigMintSpec_Validate pins that a runner refuses a spec it cannot mint safely
// before it touches a cloud: no ids, or a request the console itself would have refused.
func TestRunnerKubeconfigMintSpec_Validate(t *testing.T) {
	good := RunnerKubeconfigMintSpec{MintID: "m", ClusterID: "c", Tier: KubeconfigMintTierAdmin, Shape: KubeconfigMintShapeStatic, TTLSeconds: 900, ClientPublicKey: testMintKey}
	if err := good.Validate(); err != nil {
		t.Fatalf("a well-formed spec was refused: %v", err)
	}
	noMint, noCluster, badTTL := good, good, good
	noMint.MintID = ""
	noCluster.ClusterID = ""
	badTTL.TTLSeconds = 60
	for name, s := range map[string]RunnerKubeconfigMintSpec{"no mint id": noMint, "no cluster id": noCluster, "ttl under 15m": badTTL} {
		if err := s.Validate(); !errors.Is(err, ErrKubeconfigMintInvalid) {
			t.Errorf("%s: want ErrKubeconfigMintInvalid, got %v", name, err)
		}
	}
}

// TestKubeconfigMint_UnknownValuesRefused covers the arms that only an unknown enum value reaches.
func TestKubeconfigMint_UnknownValuesRefused(t *testing.T) {
	f := false
	exp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	errs := map[string]error{
		"result: unknown status":    RunnerKubeconfigMintResult{Status: "sealed", MintID: "m"}.Validate(),
		"result: ready with reason": RunnerKubeconfigMintResult{Status: KubeconfigMintStatusReady, MintID: "m", Sealed: "abc", Reason: "r", PrivateEndpoint: &f}.Validate(),
		"poll: ready with reason":   KubeconfigMintPollResponse{Status: KubeconfigMintStatusReady, Sealed: "abc", Reason: "r", PrivateEndpoint: &f}.Validate(),
		"credential: unknown tier":  KubeconfigMintCredential{Shape: KubeconfigMintShapeStatic, Tier: "root", Kubeconfig: "k", ExpiresAt: exp}.Validate(),
		"credential: unknown shape": KubeconfigMintCredential{Shape: "file", Tier: KubeconfigMintTierAdmin, Kubeconfig: "k", ExpiresAt: exp}.Validate(),
	}
	for name, err := range errs {
		if !errors.Is(err, ErrKubeconfigMintInvalid) {
			t.Errorf("%s: want ErrKubeconfigMintInvalid, got %v", name, err)
		}
	}
}
