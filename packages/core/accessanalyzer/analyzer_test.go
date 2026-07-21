// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package accessanalyzer

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/accessanalyzer"
	"github.com/aws/aws-sdk-go-v2/service/accessanalyzer/types"
)

type fakeAccessAnalyzerClient struct {
	results map[string]types.CheckAccessNotGrantedResult
	errOn   string
	seen    []string
}

func (f *fakeAccessAnalyzerClient) CheckAccessNotGranted(_ context.Context, in *accessanalyzer.CheckAccessNotGrantedInput, _ ...func(*accessanalyzer.Options)) (*accessanalyzer.CheckAccessNotGrantedOutput, error) {
	if in.PolicyDocument == nil || *in.PolicyDocument == "" {
		return nil, errors.New("missing policy")
	}
	if in.PolicyType != types.AccessCheckPolicyTypeIdentityPolicy {
		return nil, errors.New("wrong policy type")
	}
	if len(in.Access) != 1 || len(in.Access[0].Actions) != 1 {
		return nil, errors.New("expected one action per check")
	}
	action := in.Access[0].Actions[0]
	f.seen = append(f.seen, action)
	if action == f.errOn {
		return nil, errors.New("aws unavailable")
	}
	return &accessanalyzer.CheckAccessNotGrantedOutput{Result: f.results[action]}, nil
}

func TestCheckAccessNotGrantedReturnsGrantableDeniedActions(t *testing.T) {
	fake := &fakeAccessAnalyzerClient{results: map[string]types.CheckAccessNotGrantedResult{
		"s3:DeleteBucket":  types.CheckAccessNotGrantedResultPass,
		"iam:PassRole":     types.CheckAccessNotGrantedResultFail,
		"ec2:RunInstances": types.CheckAccessNotGrantedResultFail,
	}}
	checker := &Checker{client: fake}

	got, err := checker.CheckAccessNotGranted(context.Background(), `{"Statement":[]}`, []string{
		"s3:DeleteBucket",
		"iam:PassRole",
		"ec2:RunInstances",
	})
	if err != nil {
		t.Fatalf("CheckAccessNotGranted: %v", err)
	}
	if strings.Join(got, ",") != "iam:PassRole,ec2:RunInstances" {
		t.Fatalf("grantable actions = %#v", got)
	}
	if strings.Join(fake.seen, ",") != "s3:DeleteBucket,iam:PassRole,ec2:RunInstances" {
		t.Fatalf("checked actions = %#v", fake.seen)
	}
}

func TestCheckAccessNotGrantedAnnotatesActionOnAnalyzerError(t *testing.T) {
	fake := &fakeAccessAnalyzerClient{
		results: map[string]types.CheckAccessNotGrantedResult{},
		errOn:   "iam:CreatePolicy",
	}
	checker := &Checker{client: fake}

	_, err := checker.CheckAccessNotGranted(context.Background(), `{"Statement":[]}`, []string{"iam:CreatePolicy"})
	if err == nil || !strings.Contains(err.Error(), "CheckAccessNotGranted(iam:CreatePolicy)") || !strings.Contains(err.Error(), "aws unavailable") {
		t.Fatalf("error = %v", err)
	}
}

func TestConstructorsReturnCheckers(t *testing.T) {
	if New(nil) == nil {
		t.Fatal("New returned nil")
	}
	if NewFromConfig(aws.Config{}) == nil {
		t.Fatal("NewFromConfig returned nil")
	}
}
