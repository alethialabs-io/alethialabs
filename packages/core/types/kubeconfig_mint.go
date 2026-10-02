// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

// The short-lived kubeconfig mint channel (#5250 decisions 1–8; seams #5280). These are the Go
// mirrors of the Zod schemas in apps/console/lib/validations/cli-contract.ts; the shared fixtures
// in packages/core/api/testdata (kubeconfig_mint_*.json, runner_kubeconfig_mint_*.json) are
// strict-decoded into them by packages/core/api/contract_test.go and parsed against the Zod side by
// apps/console/tests/validations/cli-contract.test.ts, so neither half can drift alone.
//
// The flow: the client POSTs a KubeconfigMintRequest carrying an ephemeral X25519 PUBLIC key; the
// runner reads a RunnerKubeconfigMintSpec, mints in-network, HPKE-seals a KubeconfigMintCredential
// to that key (packages/core/kubeaccess), and posts a RunnerKubeconfigMintResult carrying the
// ciphertext only; the client polls KubeconfigMintPollResponse and opens `sealed` locally. The
// console never holds the plaintext. The enums (KubeconfigMintTier / Shape / Status) are generated
// into enums_gen.go from the drizzle SSOT.

// The bounds below are the decisions in #5250 §2, and the console enforces the same numbers (the
// kubeconfig_mint_requests CHECK constraints and the Zod contract). Each side pins them as literals
// in its own tests.
const (
	// KubeconfigMintTTLMinSeconds is the shortest credential a mint may request (15 min): ACK's
	// TemporaryDurationMinutes floor is 15, and TokenRequest refuses expirationSeconds under 600.
	KubeconfigMintTTLMinSeconds = 900
	// KubeconfigMintTTLDefaultSeconds is the credential TTL when the client names none (1h).
	KubeconfigMintTTLDefaultSeconds = 3600
	// KubeconfigMintTTLMaxSeconds is the longest credential a mint may request (8h).
	KubeconfigMintTTLMaxSeconds = 28_800
	// KubeconfigMintPublicKeyBytes is the raw length of the client's X25519 public key.
	KubeconfigMintPublicKeyBytes = 32
	// KubeconfigMintSealedMaxLength bounds the base64url ciphertext a runner may post.
	KubeconfigMintSealedMaxLength = 65_536
	// KubeconfigMintFailureReasonMaxLength bounds a failure reason (it must never carry a blob).
	KubeconfigMintFailureReasonMaxLength = 500
)

// KubeconfigMintRequest is the body of POST /api/cli/clusters/:id/kubeconfig. The cluster comes
// from the path and is resolved server-side against the actor's org; nothing about the cluster's
// identity (server, CA, name) is accepted from the client.
type KubeconfigMintRequest struct {
	Tier            KubeconfigMintTier  `json:"tier"`
	TTLSeconds      int                 `json:"ttl_seconds"`
	Shape           KubeconfigMintShape `json:"shape"`
	ClientPublicKey string              `json:"client_public_key"`
}

// KubeconfigMint is the queued mint the request route returns. ExpiresAt ends the POLL window, not
// the credential (whose lifetime is TTLSeconds, counted from the moment the runner mints).
type KubeconfigMint struct {
	ID         string               `json:"id"`
	ClusterID  string               `json:"cluster_id"`
	JobID      string               `json:"job_id"`
	Tier       KubeconfigMintTier   `json:"tier"`
	Shape      KubeconfigMintShape  `json:"shape"`
	TTLSeconds int                  `json:"ttl_seconds"`
	Status     KubeconfigMintStatus `json:"status"`
	ExpiresAt  time.Time            `json:"expires_at"`
}

// KubeconfigMintResponse is the 202 result of POST /api/cli/clusters/:id/kubeconfig.
type KubeconfigMintResponse struct {
	Mint KubeconfigMint `json:"mint"`
}

// KubeconfigMintPollResponse is one GET /api/cli/clusters/:id/kubeconfig/:mintId. Which fields are
// present depends on Status (the Zod side is a discriminated union): ExpiresAt on pending, Sealed
// on ready, Reason on failed. PrivateEndpoint is nil until the runner reports it; true means the
// API server needs network access (VPN/bastion) the caller may not have (decision 6).
type KubeconfigMintPollResponse struct {
	Status          KubeconfigMintStatus `json:"status"`
	PrivateEndpoint *bool                `json:"private_endpoint"`
	ExpiresAt       *time.Time           `json:"expires_at,omitempty"`
	Sealed          string               `json:"sealed,omitempty"`
	Reason          string               `json:"reason,omitempty"`
}

// RunnerKubeconfigMintSpec is GET /api/jobs/:id/kubeconfig-mint: what the MINT_KUBECONFIG job must
// mint and whom to seal it to. It holds no secret.
type RunnerKubeconfigMintSpec struct {
	MintID          string              `json:"mint_id"`
	ClusterID       string              `json:"cluster_id"`
	Tier            KubeconfigMintTier  `json:"tier"`
	Shape           KubeconfigMintShape `json:"shape"`
	TTLSeconds      int                 `json:"ttl_seconds"`
	ClientPublicKey string              `json:"client_public_key"`
}

// RunnerKubeconfigMintResult is the body of POST /api/jobs/:id/kubeconfig-mint — the one-shot
// result channel, and the ONLY path a mint result takes (never execution_metadata or job_logs).
// Status is KubeconfigMintStatusReady (with Sealed) or KubeconfigMintStatusFailed (with Reason).
type RunnerKubeconfigMintResult struct {
	Status          KubeconfigMintStatus `json:"status"`
	MintID          string               `json:"mint_id"`
	Sealed          string               `json:"sealed,omitempty"`
	Reason          string               `json:"reason,omitempty"`
	PrivateEndpoint *bool                `json:"private_endpoint"`
}

// KubeconfigMintCredential is the PLAINTEXT the runner seals and the client opens. It is never a
// console wire shape. Exec carries Server, CertificateAuthorityData (standard base64, as the
// kubeconfig field takes it) and Token; Static carries a complete Kubeconfig.
type KubeconfigMintCredential struct {
	Shape                    KubeconfigMintShape `json:"shape"`
	Tier                     KubeconfigMintTier  `json:"tier"`
	Server                   string              `json:"server,omitempty"`
	CertificateAuthorityData string              `json:"certificate_authority_data,omitempty"`
	Token                    string              `json:"token,omitempty"`
	Kubeconfig               string              `json:"kubeconfig,omitempty"`
	ExpiresAt                time.Time           `json:"expires_at"`
}

// ErrKubeconfigMintInvalid is wrapped by every Validate error below.
var ErrKubeconfigMintInvalid = errors.New("invalid kubeconfig mint")

// invalid builds a validation error that wraps ErrKubeconfigMintInvalid.
func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrKubeconfigMintInvalid, fmt.Sprintf(format, args...))
}

// validTier reports whether t is a generated KubeconfigMintTier value.
func validTier(t KubeconfigMintTier) bool {
	for _, v := range AllKubeconfigMintTiers {
		if v == t {
			return true
		}
	}
	return false
}

// validShape reports whether s is a generated KubeconfigMintShape value.
func validShape(s KubeconfigMintShape) bool {
	for _, v := range AllKubeconfigMintShapes {
		if v == s {
			return true
		}
	}
	return false
}

// ValidateKubeconfigMintTTL checks a credential TTL against the 15m–8h bounds.
func ValidateKubeconfigMintTTL(ttlSeconds int) error {
	if ttlSeconds < KubeconfigMintTTLMinSeconds || ttlSeconds > KubeconfigMintTTLMaxSeconds {
		return invalid("ttl_seconds %d outside [%d, %d]", ttlSeconds, KubeconfigMintTTLMinSeconds, KubeconfigMintTTLMaxSeconds)
	}
	return nil
}

// DecodeKubeconfigMintPublicKey decodes an unpadded base64url X25519 public key and checks its
// length. Strict decoding refuses padding, the standard alphabet and non-canonical trailing bits.
func DecodeKubeconfigMintPublicKey(b64url string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(b64url)
	if err != nil {
		return nil, invalid("client_public_key is not unpadded base64url: %v", err)
	}
	if len(raw) != KubeconfigMintPublicKeyBytes {
		return nil, invalid("client_public_key is %d bytes, want %d", len(raw), KubeconfigMintPublicKeyBytes)
	}
	return raw, nil
}

// Validate checks a mint request the way the console's Zod schema does (after defaults).
func (r KubeconfigMintRequest) Validate() error {
	if !validTier(r.Tier) {
		return invalid("unknown tier %q", r.Tier)
	}
	if !validShape(r.Shape) {
		return invalid("unknown shape %q", r.Shape)
	}
	if err := ValidateKubeconfigMintTTL(r.TTLSeconds); err != nil {
		return err
	}
	_, err := DecodeKubeconfigMintPublicKey(r.ClientPublicKey)
	return err
}

// Validate checks the spec a runner received before it mints anything.
func (s RunnerKubeconfigMintSpec) Validate() error {
	if s.MintID == "" || s.ClusterID == "" {
		return invalid("mint_id and cluster_id are required")
	}
	return KubeconfigMintRequest{
		Tier: s.Tier, TTLSeconds: s.TTLSeconds, Shape: s.Shape, ClientPublicKey: s.ClientPublicKey,
	}.Validate()
}

// Validate checks that a poll answer carries exactly what its Status promises.
func (p KubeconfigMintPollResponse) Validate() error {
	switch p.Status {
	case KubeconfigMintStatusPending:
		if p.Sealed != "" || p.Reason != "" {
			return invalid("a pending mint carries neither sealed nor reason")
		}
	case KubeconfigMintStatusReady:
		if p.Sealed == "" || p.PrivateEndpoint == nil {
			return invalid("a ready mint carries sealed and private_endpoint")
		}
		if p.Reason != "" {
			return invalid("a ready mint carries no reason")
		}
	case KubeconfigMintStatusFailed:
		if p.Reason == "" || p.Sealed != "" {
			return invalid("a failed mint carries a reason and no sealed")
		}
	case KubeconfigMintStatusExpired:
		if p.Sealed != "" || p.Reason != "" {
			return invalid("an expired mint carries neither sealed nor reason")
		}
	default:
		return invalid("unknown status %q", p.Status)
	}
	return nil
}

// Validate checks a result before the runner posts it: ready ⇒ ciphertext only; failed ⇒ a bounded
// reason. Any other status is refused — the runner never reports pending or expired.
func (r RunnerKubeconfigMintResult) Validate() error {
	if r.MintID == "" {
		return invalid("mint_id is required")
	}
	switch r.Status {
	case KubeconfigMintStatusReady:
		if r.Sealed == "" || r.Reason != "" || r.PrivateEndpoint == nil {
			return invalid("a ready result carries sealed and private_endpoint, and no reason")
		}
		if len(r.Sealed) > KubeconfigMintSealedMaxLength {
			return invalid("sealed is %d chars, max %d", len(r.Sealed), KubeconfigMintSealedMaxLength)
		}
	case KubeconfigMintStatusFailed:
		if r.Reason == "" || r.Sealed != "" {
			return invalid("a failed result carries a reason and no sealed")
		}
		if len(r.Reason) > KubeconfigMintFailureReasonMaxLength {
			return invalid("reason is %d chars, max %d", len(r.Reason), KubeconfigMintFailureReasonMaxLength)
		}
	case KubeconfigMintStatusPending, KubeconfigMintStatusExpired:
		return invalid("a runner reports ready or failed, not %q", r.Status)
	default:
		return invalid("unknown status %q", r.Status)
	}
	return nil
}

// Validate checks an opened credential: exec carries server, CA and token; static carries a
// kubeconfig; neither carries the other's fields.
func (c KubeconfigMintCredential) Validate() error {
	if !validTier(c.Tier) {
		return invalid("unknown tier %q", c.Tier)
	}
	if c.ExpiresAt.IsZero() {
		return invalid("expires_at is required")
	}
	switch c.Shape {
	case KubeconfigMintShapeExec:
		if c.Server == "" || c.CertificateAuthorityData == "" || c.Token == "" || c.Kubeconfig != "" {
			return invalid("an exec credential carries server, certificate_authority_data and token, and no kubeconfig")
		}
	case KubeconfigMintShapeStatic:
		if c.Kubeconfig == "" || c.Server != "" || c.CertificateAuthorityData != "" || c.Token != "" {
			return invalid("a static credential carries a kubeconfig and nothing else")
		}
	default:
		return invalid("unknown shape %q", c.Shape)
	}
	return nil
}
