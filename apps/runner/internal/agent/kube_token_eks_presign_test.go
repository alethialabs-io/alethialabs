// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"net/url"
	"strings"
	"testing"
)

// TestMintAWSEKSTokenPresignShape decodes a locally-minted EKS token (the presign is offline — no
// cluster, no network) and asserts the presigned GetCallerIdentity URL has the exact shape EKS's
// authenticator requires. Regression for #1040: EKS rejects the token (401) — even with a matching
// cluster-admin access entry — unless the presign carries X-Amz-Expires AND signs the x-k8s-aws-id
// header. The prior code set neither an explicit expiry (so X-Amz-Expires was omitted entirely),
// which is exactly the failure this test now guards.
func TestMintAWSEKSTokenPresignShape(t *testing.T) {
	// Deterministic, offline SigV4 signing needs *some* credentials; use static dummy ones so the
	// test never depends on the ambient AWS environment.
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_REGION", "us-east-1")

	tok, _, err := mintAWSEKSToken(context.Background(), "eks-ue1-test-cluster", "us-east-1")
	if err != nil {
		t.Fatalf("mintAWSEKSToken: %v", err)
	}
	if !strings.HasPrefix(tok, eksTokenPrefix) {
		t.Fatalf("token missing %q prefix", eksTokenPrefix)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(tok, eksTokenPrefix))
	if err != nil {
		t.Fatalf("base64url decode: %v", err)
	}
	u, err := url.Parse(string(raw))
	if err != nil {
		t.Fatalf("url parse: %v", err)
	}
	q := u.Query()

	// (1) x-k8s-aws-id must be a SIGNED header — EKS binds the token to the cluster through it.
	if sh := q.Get("X-Amz-SignedHeaders"); !strings.Contains(sh, "x-k8s-aws-id") {
		t.Errorf("X-Amz-SignedHeaders %q must contain x-k8s-aws-id", sh)
	}
	// (2) X-Amz-Expires must be present and non-zero — the #1040 bug (previously omitted → 401).
	if exp := q.Get("X-Amz-Expires"); exp == "" || exp == "0" {
		t.Errorf("#1040 regression: X-Amz-Expires is %q — the presign must carry a valid expiry or EKS 401s", exp)
	}
	// (3) Sanity: it is a GetCallerIdentity SigV4 presign against the regional STS endpoint.
	if got := q.Get("Action"); got != "GetCallerIdentity" {
		t.Errorf("Action = %q, want GetCallerIdentity", got)
	}
	if !strings.Contains(u.Host, "sts.") {
		t.Errorf("host = %q, want an sts.* endpoint", u.Host)
	}
}
