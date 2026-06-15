// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package azure

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/dns/armdns"
)

type DNSClient struct {
	subscriptionID string
	cred           *azidentity.DefaultAzureCredential
}

func NewDNSClient(ctx context.Context, subscriptionID string) (*DNSClient, error) {
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create Azure credential: %w", err)
	}
	return &DNSClient{subscriptionID: subscriptionID, cred: cred}, nil
}

type DnsZoneInfo struct {
	Name     string
	ID       string
	ZoneType string
}

func (c *DNSClient) ListDnsZones(ctx context.Context) ([]DnsZoneInfo, error) {
	client, err := armdns.NewZonesClient(c.subscriptionID, c.cred, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create DNS zones client: %w", err)
	}

	var zones []DnsZoneInfo
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list DNS zones: %w", err)
		}
		for _, z := range page.Value {
			name := ""
			if z.Name != nil {
				name = *z.Name
			}
			id := ""
			if z.ID != nil {
				id = *z.ID
			}
			zoneType := "Public"
			if z.Properties != nil && z.Properties.ZoneType != nil {
				zoneType = string(*z.Properties.ZoneType)
			}
			zones = append(zones, DnsZoneInfo{
				Name:     name,
				ID:       id,
				ZoneType: zoneType,
			})
		}
	}
	return zones, nil
}
