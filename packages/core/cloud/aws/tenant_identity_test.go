// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	iamtypes "github.com/aws/aws-sdk-go-v2/service/iam/types"
)

// fakeIAM implements IAMRoleAPI for the per-namespace identity lifecycle tests.
type fakeIAM struct {
	createErr error
	createARN string
	getARN    string
	deleteErr error

	created *iam.CreateRoleInput
	updated *iam.UpdateAssumeRolePolicyInput
	deleted *iam.DeleteRoleInput
}

func (f *fakeIAM) CreateRole(_ context.Context, in *iam.CreateRoleInput, _ ...func(*iam.Options)) (*iam.CreateRoleOutput, error) {
	f.created = in
	if f.createErr != nil {
		return nil, f.createErr
	}
	return &iam.CreateRoleOutput{Role: &iamtypes.Role{Arn: awssdk.String(f.createARN)}}, nil
}
func (f *fakeIAM) GetRole(_ context.Context, _ *iam.GetRoleInput, _ ...func(*iam.Options)) (*iam.GetRoleOutput, error) {
	return &iam.GetRoleOutput{Role: &iamtypes.Role{Arn: awssdk.String(f.getARN)}}, nil
}
func (f *fakeIAM) UpdateAssumeRolePolicy(_ context.Context, in *iam.UpdateAssumeRolePolicyInput, _ ...func(*iam.Options)) (*iam.UpdateAssumeRolePolicyOutput, error) {
	f.updated = in
	return &iam.UpdateAssumeRolePolicyOutput{}, nil
}
func (f *fakeIAM) DeleteRole(_ context.Context, in *iam.DeleteRoleInput, _ ...func(*iam.Options)) (*iam.DeleteRoleOutput, error) {
	f.deleted = in
	if f.deleteErr != nil {
		return nil, f.deleteErr
	}
	return &iam.DeleteRoleOutput{}, nil
}

func TestBuildNamespaceTrustPolicy(t *testing.T) {
	pol, err := buildNamespaceTrustPolicy(
		"arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC",
		"oidc.eks.us-east-1.amazonaws.com/id/ABC",
		"team-a",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var doc struct {
		Statement []struct {
			Effect    string
			Principal struct{ Federated string }
			Action    string
			Condition map[string]map[string]string
		}
	}
	if err := json.Unmarshal([]byte(pol), &doc); err != nil {
		t.Fatalf("trust policy is not valid JSON: %v\n%s", err, pol)
	}
	if len(doc.Statement) != 1 {
		t.Fatalf("want 1 statement, got %d", len(doc.Statement))
	}
	s := doc.Statement[0]
	if s.Effect != "Allow" || s.Action != "sts:AssumeRoleWithWebIdentity" {
		t.Fatalf("effect/action = %q/%q", s.Effect, s.Action)
	}
	if s.Principal.Federated != "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC" {
		t.Fatalf("federated principal = %q", s.Principal.Federated)
	}
	if got := s.Condition["StringLike"]["oidc.eks.us-east-1.amazonaws.com/id/ABC:sub"]; got != "system:serviceaccount:team-a:*" {
		t.Fatalf("sub condition = %q, want namespace-wide binding", got)
	}
	if got := s.Condition["StringEquals"]["oidc.eks.us-east-1.amazonaws.com/id/ABC:aud"]; got != "sts.amazonaws.com" {
		t.Fatalf("aud condition = %q", got)
	}
}

func TestNamespaceRoleName(t *testing.T) {
	name := namespaceRoleName("prod-eks-cluster", "team-a")
	if !strings.HasPrefix(name, "alethia-ns-") {
		t.Fatalf("role name %q missing prefix", name)
	}
	if len(name) > 64 {
		t.Fatalf("role name %q exceeds IAM's 64-char limit (%d)", name, len(name))
	}
	// Deterministic (idempotent re-deploy reconciles the SAME role).
	if name != namespaceRoleName("prod-eks-cluster", "team-a") {
		t.Fatal("role name is not deterministic")
	}
	// A long namespace stays bounded and distinct per (cluster, ns).
	long := namespaceRoleName("some-very-long-cluster-name-indeed", strings.Repeat("x", 60))
	if len(long) > 64 {
		t.Fatalf("long-namespace role name exceeds 64 chars (%d): %q", len(long), long)
	}
	if long == name {
		t.Fatal("different inputs collided to the same role name")
	}
}

func TestEnsureNamespaceIRSARole_Create(t *testing.T) {
	f := &fakeIAM{createARN: "arn:aws:iam::111122223333:role/alethia-ns-team-a-deadbeef"}
	arn, err := EnsureNamespaceIRSARole(context.Background(), f, "alethia-ns-team-a-deadbeef", `{"trust":"doc"}`, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if arn != f.createARN {
		t.Fatalf("arn = %q", arn)
	}
	if f.created == nil || awssdk.ToString(f.created.AssumeRolePolicyDocument) != `{"trust":"doc"}` {
		t.Fatal("CreateRole did not receive the trust policy")
	}
	if f.updated != nil {
		t.Fatal("should not reconcile on a fresh create")
	}
}

func TestEnsureNamespaceIRSARole_AlreadyExistsReconciles(t *testing.T) {
	f := &fakeIAM{
		createErr: &iamtypes.EntityAlreadyExistsException{Message: awssdk.String("exists")},
		getARN:    "arn:aws:iam::111122223333:role/alethia-ns-team-a-deadbeef",
	}
	arn, err := EnsureNamespaceIRSARole(context.Background(), f, "alethia-ns-team-a-deadbeef", `{"trust":"v2"}`, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if arn != f.getARN {
		t.Fatalf("arn = %q, want the existing role's ARN", arn)
	}
	if f.updated == nil || awssdk.ToString(f.updated.PolicyDocument) != `{"trust":"v2"}` {
		t.Fatal("existing role's trust policy was not reconciled")
	}
}

func TestDeleteNamespaceIRSARole_MissingIsNoError(t *testing.T) {
	f := &fakeIAM{deleteErr: &iamtypes.NoSuchEntityException{Message: awssdk.String("gone")}}
	if err := DeleteNamespaceIRSARole(context.Background(), f, "alethia-ns-team-a-deadbeef"); err != nil {
		t.Fatalf("deleting a missing role must be a no-op, got %v", err)
	}
	if f.deleted == nil {
		t.Fatal("DeleteRole was not called")
	}
}

func TestNamespaceRoleAndTrust(t *testing.T) {
	// No OIDC issuer → fail closed (IRSA not enabled on the Fabric).
	if _, _, err := namespaceRoleAndTrust(EKSClusterConn{ARN: "arn:aws:eks:us-east-1:111122223333:cluster/c"}, "c", "team-a"); err == nil {
		t.Fatal("want error when the cluster reports no OIDC issuer")
	}
	// Valid conn → role name + a trust policy naming the derived provider ARN.
	name, trust, err := namespaceRoleAndTrust(EKSClusterConn{
		ARN:        "arn:aws:eks:us-east-1:111122223333:cluster/prod",
		OIDCIssuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC",
	}, "prod", "team-a")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(name, "alethia-ns-") {
		t.Fatalf("role name = %q", name)
	}
	if !strings.Contains(trust, "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC") {
		t.Fatalf("trust policy missing derived provider ARN:\n%s", trust)
	}
}

func TestARNDerivationHelpers(t *testing.T) {
	acct, err := accountIDFromClusterARN("arn:aws:eks:us-east-1:111122223333:cluster/prod")
	if err != nil || acct != "111122223333" {
		t.Fatalf("account = %q, err = %v", acct, err)
	}
	if _, err := accountIDFromClusterARN("not-an-arn"); err == nil {
		t.Fatal("want error on malformed ARN")
	}
	key, err := oidcConditionKey("https://oidc.eks.us-east-1.amazonaws.com/id/ABC")
	if err != nil || key != "oidc.eks.us-east-1.amazonaws.com/id/ABC" {
		t.Fatalf("key = %q, err = %v", key, err)
	}
	if _, err := oidcConditionKey("oidc.eks.example/id/x"); err == nil {
		t.Fatal("want error on a non-https issuer")
	}
}

func TestIsValidRoleARN(t *testing.T) {
	valid := []string{
		"arn:aws:iam::111122223333:role/alethia-ns-team-a-deadbeef",
		"arn:aws-us-gov:iam::111122223333:role/some.role_name",
	}
	for _, a := range valid {
		if !IsValidRoleARN(a) {
			t.Errorf("expected valid: %q", a)
		}
	}
	invalid := []string{
		"",
		"arn:aws:iam::111122223333:role/x; rm -rf /", // shell-injection attempt
		"arn:aws:iam::abc:role/x",                    // non-numeric account
		"arn:aws:eks:us-east-1:111122223333:cluster/c",
	}
	for _, a := range invalid {
		if IsValidRoleARN(a) {
			t.Errorf("expected invalid: %q", a)
		}
	}
}
