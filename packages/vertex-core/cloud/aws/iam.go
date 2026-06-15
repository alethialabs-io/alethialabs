// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/iam"
)

type IAMClient struct {
	client *iam.Client
}

type IAMUserInfo struct {
	Username string `json:"username"`
	Arn      string `json:"arn"`
	Path     string `json:"path"`
}

func NewIAMClient(ctx context.Context, opts AWSOptions) (*IAMClient, error) {
	cfg, err := LoadConfig(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}
	return &IAMClient{client: iam.NewFromConfig(cfg)}, nil
}

func (c *IAMClient) ListUsers(ctx context.Context) ([]IAMUserInfo, error) {
	var users []IAMUserInfo
	paginator := iam.NewListUsersPaginator(c.client, &iam.ListUsersInput{})

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list IAM users: %w", err)
		}
		for _, u := range page.Users {
			users = append(users, IAMUserInfo{
				Username: derefStr(u.UserName),
				Arn:      derefStr(u.Arn),
				Path:     derefStr(u.Path),
			})
		}
	}
	return users, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
