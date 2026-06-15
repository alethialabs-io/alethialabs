// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package gcp

import (
	"context"
	"fmt"

	"google.golang.org/api/compute/v1"
	"google.golang.org/api/option"
)

type ComputeClient struct {
	svc       *compute.Service
	projectID string
}

func NewComputeClient(ctx context.Context, projectID string) (*ComputeClient, error) {
	svc, err := compute.NewService(ctx, option.WithScopes(compute.ComputeReadonlyScope))
	if err != nil {
		return nil, fmt.Errorf("failed to create compute service: %w", err)
	}
	return &ComputeClient{svc: svc, projectID: projectID}, nil
}

type RegionInfo struct {
	Name   string
	Status string
}

func (c *ComputeClient) ListRegions(ctx context.Context) ([]string, error) {
	resp, err := c.svc.Regions.List(c.projectID).Context(ctx).Do()
	if err != nil {
		return nil, fmt.Errorf("failed to list regions: %w", err)
	}

	var regions []string
	for _, r := range resp.Items {
		if r.Status == "UP" {
			regions = append(regions, r.Name)
		}
	}
	return regions, nil
}

type NetworkInfo struct {
	Name                  string
	SelfLink              string
	AutoCreateSubnetworks bool
}

func (c *ComputeClient) ListNetworks(ctx context.Context) ([]NetworkInfo, error) {
	resp, err := c.svc.Networks.List(c.projectID).Context(ctx).Do()
	if err != nil {
		return nil, fmt.Errorf("failed to list networks: %w", err)
	}

	var networks []NetworkInfo
	for _, n := range resp.Items {
		networks = append(networks, NetworkInfo{
			Name:                  n.Name,
			SelfLink:              n.SelfLink,
			AutoCreateSubnetworks: n.AutoCreateSubnetworks,
		})
	}
	return networks, nil
}

type SubnetInfo struct {
	Name        string
	Region      string
	IpCidrRange string
	Network     string
}

func (c *ComputeClient) ListSubnetworks(ctx context.Context, region string) ([]SubnetInfo, error) {
	resp, err := c.svc.Subnetworks.List(c.projectID, region).Context(ctx).Do()
	if err != nil {
		return nil, fmt.Errorf("failed to list subnetworks in %s: %w", region, err)
	}

	var subnets []SubnetInfo
	for _, s := range resp.Items {
		subnets = append(subnets, SubnetInfo{
			Name:        s.Name,
			Region:      s.Region,
			IpCidrRange: s.IpCidrRange,
			Network:     s.Network,
		})
	}
	return subnets, nil
}
