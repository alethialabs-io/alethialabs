package gcp

import (
	"context"
	"fmt"

	"google.golang.org/api/dns/v1"
	"google.golang.org/api/option"
)

type DNSClient struct {
	svc       *dns.Service
	projectID string
}

func NewDNSClient(ctx context.Context, projectID string) (*DNSClient, error) {
	svc, err := dns.NewService(ctx, option.WithScopes(dns.NdevClouddnsReadonlyScope))
	if err != nil {
		return nil, fmt.Errorf("failed to create DNS service: %w", err)
	}
	return &DNSClient{svc: svc, projectID: projectID}, nil
}

type ManagedZoneInfo struct {
	Name       string
	DnsName    string
	Visibility string
}

func (c *DNSClient) ListManagedZones(ctx context.Context) ([]ManagedZoneInfo, error) {
	resp, err := c.svc.ManagedZones.List(c.projectID).Context(ctx).Do()
	if err != nil {
		return nil, fmt.Errorf("failed to list managed zones: %w", err)
	}

	var zones []ManagedZoneInfo
	for _, z := range resp.ManagedZones {
		zones = append(zones, ManagedZoneInfo{
			Name:       z.Name,
			DnsName:    z.DnsName,
			Visibility: z.Visibility,
		})
	}
	return zones, nil
}
