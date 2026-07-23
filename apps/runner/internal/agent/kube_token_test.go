// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// TestMintAWSEKSToken_SignsClusterHeader is the make-or-break check: the EKS token must be a
// base64url-no-pad presigned STS GetCallerIdentity URL with the x-k8s-aws-id cluster header
// present in the *signed* headers. Setting the header unsigned is the classic way this breaks
// (EKS rejects the token). Presigning is offline, so this runs with static fake creds and no
// network.
func TestMintAWSEKSToken_SignsClusterHeader(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
	// Isolate from any ambient profile/config so LoadDefaultConfig uses the env creds.
	t.Setenv("AWS_CONFIG_FILE", "/dev/null")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null")
	t.Setenv("AWS_PROFILE", "")

	token, exp, err := mintAWSEKSToken(context.Background(), "my-eks-cluster", "us-east-1")
	if err != nil {
		t.Fatalf("mintAWSEKSToken: %v", err)
	}

	if !strings.HasPrefix(token, eksTokenPrefix) {
		t.Fatalf("token missing %q prefix: %q", eksTokenPrefix, token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, eksTokenPrefix))
	if err != nil {
		t.Fatalf("token body is not base64url-no-pad: %v", err)
	}
	url := string(raw)

	if !strings.Contains(url, "Action=GetCallerIdentity") {
		t.Errorf("presigned URL is not a GetCallerIdentity call: %s", url)
	}
	// The cluster header must appear in X-Amz-SignedHeaders — i.e. it is signed.
	lower := strings.ToLower(url)
	if !strings.Contains(lower, "x-amz-signedheaders") || !strings.Contains(lower, "x-k8s-aws-id") {
		t.Errorf("x-k8s-aws-id not signed into the presigned URL (SignedHeaders): %s", url)
	}
	// Regional STS host for the requested region.
	if !strings.Contains(lower, "sts.us-east-1.amazonaws.com") {
		t.Errorf("expected regional STS host in URL: %s", url)
	}
	if exp.Before(time.Now()) {
		t.Errorf("expiration timestamp is in the past: %v", exp)
	}
}

func TestRunKubeToken_UnsupportedProvider(t *testing.T) {
	if err := RunKubeToken(context.Background(), []string{"--provider", "digitalocean"}); err == nil {
		t.Error("expected error for unsupported provider, got nil")
	}
}

func TestRunKubeToken_AlibabaNotYetWired(t *testing.T) {
	// alibaba is a recognized seam (#1129) — it must fail closed with a follow-up-naming error, not
	// mint a token and not fall through to the opaque "unsupported provider" default.
	err := RunKubeToken(context.Background(), []string{"--provider", "alibaba", "--cluster", "ack-fabric", "--region", "ap-southeast-1"})
	if err == nil {
		t.Fatal("expected fail-closed error for alibaba (namespace re-mint not yet wired), got nil")
	}
	if !strings.Contains(err.Error(), "#1129") {
		t.Errorf("alibaba error %q should name the follow-up (#1129)", err.Error())
	}
}
