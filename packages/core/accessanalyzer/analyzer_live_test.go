// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package accessanalyzer

import (
	"context"
	"os"
	"testing"

	"github.com/aws/aws-sdk-go-v2/config"
)

// TestLiveCheckAccessNotGranted exercises the REAL AWS IAM Access Analyzer
// CheckAccessNotGranted API through the adapter (no deployed infra — it validates a
// policy document). Gated behind ELENCH_LIVE_AWS=1 so it is skipped in normal CI; it
// needs AWS credentials with access-analyzer:CheckAccessNotGranted. Run:
//
//	ELENCH_LIVE_AWS=1 AWS_REGION=us-east-1 go test ./packages/core/accessanalyzer -run TestLive -v
func TestLiveCheckAccessNotGranted(t *testing.T) {
	if os.Getenv("ELENCH_LIVE_AWS") != "1" {
		t.Skip("set ELENCH_LIVE_AWS=1 (with AWS creds) to run the live Access Analyzer exercise")
	}
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		t.Fatalf("load AWS config: %v", err)
	}
	checker := NewFromConfig(cfg)

	// An admin policy MUST be reported as granting the sensitive actions.
	admin := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}`
	granted, err := checker.CheckAccessNotGranted(ctx, admin, []string{"iam:CreateAccessKey", "kms:Decrypt"})
	if err != nil {
		t.Fatalf("live CheckAccessNotGranted failed: %v", err)
	}
	if len(granted) == 0 {
		t.Errorf("admin policy should grant the denied actions; got none")
	}
	t.Logf("LIVE admin policy grants: %v", granted)

	// A tightly-scoped policy MUST NOT grant the sensitive action.
	scoped := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::example-bucket/*"}]}`
	g2, err := checker.CheckAccessNotGranted(ctx, scoped, []string{"iam:CreateAccessKey"})
	if err != nil {
		t.Fatalf("live CheckAccessNotGranted (scoped) failed: %v", err)
	}
	if len(g2) != 0 {
		t.Errorf("scoped policy should not grant iam:CreateAccessKey; got %v", g2)
	}
	t.Logf("LIVE scoped policy grants (expect empty): %v", g2)
}
