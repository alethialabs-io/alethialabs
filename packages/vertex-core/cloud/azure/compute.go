package azure

import (
	"context"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armsubscriptions"
)

type ParsedResourceID struct {
	ResourceGroup string
	ResourceName  string
}

// ParseResourceID extracts the resource group and resource name from an Azure resource ID
// (e.g. /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{name}).
func ParseResourceID(id string) (ParsedResourceID, error) {
	parts := strings.Split(strings.TrimPrefix(id, "/"), "/")
	parsed := ParsedResourceID{}
	for i := 0; i < len(parts)-1; i++ {
		switch strings.ToLower(parts[i]) {
		case "resourcegroups":
			parsed.ResourceGroup = parts[i+1]
		}
	}
	if len(parts) >= 2 {
		parsed.ResourceName = parts[len(parts)-1]
	}
	if parsed.ResourceGroup == "" || parsed.ResourceName == "" {
		return parsed, fmt.Errorf("could not parse resource group and name from ID: %s", id)
	}
	return parsed, nil
}

type ComputeClient struct {
	subscriptionID string
	cred           *azidentity.DefaultAzureCredential
}

func NewComputeClient(ctx context.Context, subscriptionID string) (*ComputeClient, error) {
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create Azure credential: %w", err)
	}
	return &ComputeClient{subscriptionID: subscriptionID, cred: cred}, nil
}

type LocationInfo struct {
	Name        string
	DisplayName string
}

func (c *ComputeClient) ListLocations(ctx context.Context) ([]string, error) {
	client, err := armsubscriptions.NewClient(c.cred, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create subscriptions client: %w", err)
	}

	var locations []string
	pager := client.NewListLocationsPager(c.subscriptionID, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list locations: %w", err)
		}
		for _, loc := range page.Value {
			if loc.Name != nil {
				locations = append(locations, *loc.Name)
			}
		}
	}
	return locations, nil
}

type VnetInfo struct {
	Name            string
	ID              string
	Location        string
	AddressPrefixes []string
}

func (c *ComputeClient) ListVnets(ctx context.Context) ([]VnetInfo, error) {
	client, err := armnetwork.NewVirtualNetworksClient(c.subscriptionID, c.cred, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create vnets client: %w", err)
	}

	var vnets []VnetInfo
	pager := client.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list vnets: %w", err)
		}
		for _, vnet := range page.Value {
			var prefixes []string
			if vnet.Properties != nil && vnet.Properties.AddressSpace != nil {
				for _, p := range vnet.Properties.AddressSpace.AddressPrefixes {
					if p != nil {
						prefixes = append(prefixes, *p)
					}
				}
			}
			name := ""
			if vnet.Name != nil {
				name = *vnet.Name
			}
			id := ""
			if vnet.ID != nil {
				id = *vnet.ID
			}
			location := ""
			if vnet.Location != nil {
				location = *vnet.Location
			}
			vnets = append(vnets, VnetInfo{
				Name:            name,
				ID:              id,
				Location:        location,
				AddressPrefixes: prefixes,
			})
		}
	}
	return vnets, nil
}

type SubnetInfo struct {
	Name          string
	ID            string
	AddressPrefix string
	VnetName      string
}

func (c *ComputeClient) ListSubnets(ctx context.Context, resourceGroup, vnetName string) ([]SubnetInfo, error) {
	client, err := armnetwork.NewSubnetsClient(c.subscriptionID, c.cred, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create subnets client: %w", err)
	}

	var subnets []SubnetInfo
	pager := client.NewListPager(resourceGroup, vnetName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list subnets: %w", err)
		}
		for _, s := range page.Value {
			name := ""
			if s.Name != nil {
				name = *s.Name
			}
			id := ""
			if s.ID != nil {
				id = *s.ID
			}
			prefix := ""
			if s.Properties != nil && s.Properties.AddressPrefix != nil {
				prefix = *s.Properties.AddressPrefix
			}
			subnets = append(subnets, SubnetInfo{
				Name:          name,
				ID:            id,
				AddressPrefix: prefix,
				VnetName:      vnetName,
			})
		}
	}
	return subnets, nil
}
