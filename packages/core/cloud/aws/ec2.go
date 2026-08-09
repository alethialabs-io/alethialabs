// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
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

	return regionNames(output.Regions), nil
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

	subnets := subnetInfos(output.Subnets)
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

	vpcs := vpcInfos(output.Vpcs)
	return vpcs, nil
}

// The mappers below are PURE so the nil-handling can be tested: EC2Client embeds *ec2.Client
// concretely, so there is no seam to inject a fake response through — which is exactly why this
// defect had no test (#2036).
//
// Every field on an EC2 API type is a POINTER, and AWS omits what it has nothing to say about.
// MapPublicIpOnLaunch was nil-guarded while SubnetId/CidrBlock/AvailabilityZone/VpcId were
// dereferenced raw; that inconsistency is the tell. aws.ToString / aws.ToBool are the SDK's own
// accessors — a helper that cannot be applied to one field and forgotten on the next.
//
// A subnet mid-create, a partially-populated response, or a field a future API version leaves nil
// panicked the whole runner; the zero value degrades one row instead.

// subnetInfos maps DescribeSubnets output, nil-safely.
func subnetInfos(in []ec2types.Subnet) []SubnetInfo {
	var out []SubnetInfo
	for _, s := range in {
		out = append(out, SubnetInfo{
			ID:                  aws.ToString(s.SubnetId),
			CIDR:                aws.ToString(s.CidrBlock),
			AvailabilityZone:    aws.ToString(s.AvailabilityZone),
			VpcID:               aws.ToString(s.VpcId),
			MapPublicIpOnLaunch: aws.ToBool(s.MapPublicIpOnLaunch),
		})
	}
	return out
}

// vpcInfos maps DescribeVpcs output, nil-safely. This one carried MORE unguarded derefs than the
// reported subnet case: a tag's Key and Value are pointers too, so a single nil-keyed tag panicked
// the loop before any VPC was returned.
func vpcInfos(in []ec2types.Vpc) []VPCInfo {
	var out []VPCInfo
	for _, vpc := range in {
		name := ""
		for _, tag := range vpc.Tags {
			if aws.ToString(tag.Key) == "Name" {
				name = aws.ToString(tag.Value)
				break
			}
		}
		out = append(out, VPCInfo{
			ID:        aws.ToString(vpc.VpcId),
			CIDR:      aws.ToString(vpc.CidrBlock),
			Name:      name,
			IsDefault: aws.ToBool(vpc.IsDefault),
		})
	}
	return out
}

// regionNames maps DescribeRegions output, nil-safely — the same shape, one function up.
func regionNames(in []ec2types.Region) []string {
	var out []string
	for _, r := range in {
		out = append(out, aws.ToString(r.RegionName))
	}
	return out
}
