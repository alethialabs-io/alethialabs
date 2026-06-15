// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/route53"
)

type Route53Client struct {
	*route53.Client
}

func NewRoute53Client(ctx context.Context, opts AWSOptions) (*Route53Client, error) {
	cfg, err := LoadConfig(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}
	return &Route53Client{Client: route53.NewFromConfig(cfg)}, nil
}

type HostedZoneInfo struct {
	ID          string
	Name        string
	RecordCount int64
	IsPrivate   bool
}

func (c *Route53Client) ListHostedZones(ctx context.Context) ([]HostedZoneInfo, error) {
	output, err := c.ListHostedZonesByName(ctx, &route53.ListHostedZonesByNameInput{})
	if err != nil {
		return nil, fmt.Errorf("failed to list hosted zones: %w", err)
	}

	var zones []HostedZoneInfo
	for _, z := range output.HostedZones {
		id := *z.Id
		id = strings.TrimPrefix(id, "/hostedzone/")

		zones = append(zones, HostedZoneInfo{
			ID:          id,
			Name:        strings.TrimSuffix(*z.Name, "."),
			RecordCount: *z.ResourceRecordSetCount,
			IsPrivate:   z.Config != nil && z.Config.PrivateZone,
		})
	}
	return zones, nil
}
