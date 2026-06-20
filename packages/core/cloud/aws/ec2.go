// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

type EC2Client struct {
	*ec2.Client
}

func NewEC2Client(ctx context.Context, opts AWSOptions) (*EC2Client, error) {
	cfg, err := LoadConfig(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}
	return &EC2Client{Client: ec2.NewFromConfig(cfg)}, nil
}

type SubnetInfo struct {
	ID                  string
	CIDR                string
	AvailabilityZone    string
	VpcID               string
	MapPublicIpOnLaunch bool
}

func (c *EC2Client) ListRegions(ctx context.Context) ([]string, error) {
	output, err := c.DescribeRegions(ctx, &ec2.DescribeRegionsInput{
		AllRegions: boolPtr(false),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to describe regions: %w", err)
	}

	var regions []string
	for _, r := range output.Regions {
		regions = append(regions, *r.RegionName)
	}
	return regions, nil
}

func (c *EC2Client) ListSubnets(ctx context.Context, vpcID string) ([]SubnetInfo, error) {
	output, err := c.DescribeSubnets(ctx, &ec2.DescribeSubnetsInput{
		Filters: []ec2types.Filter{
			{Name: strPtr("vpc-id"), Values: []string{vpcID}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to describe subnets: %w", err)
	}

	var subnets []SubnetInfo
	for _, s := range output.Subnets {
		mapPublic := false
		if s.MapPublicIpOnLaunch != nil {
			mapPublic = *s.MapPublicIpOnLaunch
		}
		subnets = append(subnets, SubnetInfo{
			ID:                  *s.SubnetId,
			CIDR:                *s.CidrBlock,
			AvailabilityZone:    *s.AvailabilityZone,
			VpcID:               *s.VpcId,
			MapPublicIpOnLaunch: mapPublic,
		})
	}
	return subnets, nil
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

type VPCInfo struct {
	ID        string
	CIDR      string
	Name      string
	IsDefault bool
}

func (c *EC2Client) ListVPCs(ctx context.Context) ([]VPCInfo, error) {
	output, err := c.DescribeVpcs(ctx, &ec2.DescribeVpcsInput{})
	if err != nil {
		return nil, fmt.Errorf("failed to describe VPCs: %w", err)
	}

	var vpcs []VPCInfo
	for _, vpc := range output.Vpcs {
		name := ""
		for _, tag := range vpc.Tags {
			if *tag.Key == "Name" {
				name = *tag.Value
				break
			}
		}

		vpcs = append(vpcs, VPCInfo{
			ID:        *vpc.VpcId,
			CIDR:      *vpc.CidrBlock,
			Name:      name,
			IsDefault: *vpc.IsDefault,
		})
	}

	return vpcs, nil
}
