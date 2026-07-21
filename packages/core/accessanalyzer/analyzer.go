// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package accessanalyzer is the AWS-backed implementation of verify.PolicyChecker.
// It corroborates IAM policy documents with AWS IAM Access Analyzer's automated-
// reasoning `CheckAccessNotGranted` API — a provable statement about what a policy
// *could* grant, run pre-apply without deploying anything. It is kept in its own
// package so the pure verify gate carries no AWS SDK dependency; the runner wires a
// Checker into verify.EvaluateWithOptions when AWS credentials are active.
package accessanalyzer

import (
	"context"
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/accessanalyzer"
	"github.com/aws/aws-sdk-go-v2/service/accessanalyzer/types"
)

// Checker implements verify.PolicyChecker over the Access Analyzer API.
type Checker struct {
	client accessAnalyzerAPI
}

// accessAnalyzerAPI is the subset of the Access Analyzer client the Checker calls — an
// extracted seam so the checker can be unit-tested against a fake. The real client
// (*accessanalyzer.Client) satisfies it.
type accessAnalyzerAPI interface {
	CheckAccessNotGranted(context.Context, *accessanalyzer.CheckAccessNotGrantedInput, ...func(*accessanalyzer.Options)) (*accessanalyzer.CheckAccessNotGrantedOutput, error)
}

// compile-time guarantee that Checker satisfies the verify seam.
var _ verify.PolicyChecker = (*Checker)(nil)

// New wraps an existing Access Analyzer client.
func New(client *accessanalyzer.Client) *Checker {
	return &Checker{client: client}
}

// NewFromConfig builds a Checker from a resolved AWS config (the runner already
// assumes the customer role and has an aws.Config in hand at job time).
func NewFromConfig(cfg aws.Config) *Checker {
	return &Checker{client: accessanalyzer.NewFromConfig(cfg)}
}

// CheckAccessNotGranted returns the subset of `denied` actions the policy could
// grant. It checks one action at a time so the result is per-action precise: an
// Access entry with a single action FAILs only when that exact action is grantable.
func (c *Checker) CheckAccessNotGranted(ctx context.Context, policyJSON string, denied []string) ([]string, error) {
	var granted []string
	for _, action := range denied {
		out, err := c.client.CheckAccessNotGranted(ctx, &accessanalyzer.CheckAccessNotGrantedInput{
			PolicyDocument: aws.String(policyJSON),
			PolicyType:     types.AccessCheckPolicyTypeIdentityPolicy,
			Access:         []types.Access{{Actions: []string{action}}},
		})
		if err != nil {
			return nil, fmt.Errorf("CheckAccessNotGranted(%s): %w", action, err)
		}
		if out.Result == types.CheckAccessNotGrantedResultFail {
			granted = append(granted, action)
		}
	}
	return granted, nil
}
