// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// CallerRoleARN resolves the CURRENT identity via sts:GetCallerIdentity and returns the
// path-stripped IAM role ARN that identity presents to EKS. The returned ARN is exactly the
// form the AWS IAM Authenticator matches an EKS access entry against for an assumed-role
// session, so it is safe to register as an access-entry principal.
//
// It returns ("", nil) when the caller is not an assumed role (e.g. a plain IAM user) — the
// EKS access-entry self-grant only applies to the runner's assumed provisioning role, and the
// caller should fall back to the module's creator-admin grant in that case.
func CallerRoleARN(ctx context.Context, opts AWSOptions) (string, error) {
	cfg, err := LoadConfig(ctx, opts)
	if err != nil {
		return "", fmt.Errorf("failed to load AWS config: %w", err)
	}
	out, err := sts.NewFromConfig(cfg).GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return "", fmt.Errorf("sts:GetCallerIdentity failed: %w", err)
	}
	if out.Arn == nil {
		return "", fmt.Errorf("sts:GetCallerIdentity returned no ARN")
	}
	return RoleARNFromCallerARN(*out.Arn), nil
}

// RoleARNFromCallerARN maps an sts:GetCallerIdentity caller ARN to the path-stripped IAM role
// ARN the EKS IAM Authenticator matches on. This is a pure function (no AWS calls) so the
// mapping is unit-testable.
//
// An assumed-role caller ARN is `arn:<partition>:sts::<acct>:assumed-role/<RoleName>/<session>`.
// The authenticator resolves that session to `arn:<partition>:iam::<acct>:role/<RoleName>` —
// note the STS ARN never carries the role's IAM path, so the derived role ARN is already
// path-stripped, which is precisely the form a pathed provisioning role fails to match against
// when the terraform-aws-eks module registers the *path-qualified* creator entry instead (the
// #551 EKS-path gotcha).
//
// Returns "" for any caller ARN that is not an assumed-role session (IAM users, root, service
// principals) — those have no assumed-role→role mapping to register.
func RoleARNFromCallerARN(callerARN string) string {
	// arn:partition:sts::account:assumed-role/RoleName/SessionName
	parts := strings.SplitN(callerARN, ":", 6)
	if len(parts) < 6 || parts[2] != "sts" {
		return ""
	}
	partition, account, resource := parts[1], parts[4], parts[5]
	res := strings.SplitN(resource, "/", 3)
	if len(res) < 2 || res[0] != "assumed-role" {
		return ""
	}
	roleName := res[1]
	if roleName == "" {
		return ""
	}
	return fmt.Sprintf("arn:%s:iam::%s:role/%s", partition, account, roleName)
}
