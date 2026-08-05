// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The tfvar each cloud uses as its "CREATE a zone" gate. Naming a zone you already own must turn
// this OFF — otherwise the template registers a second zone with different name servers, your
// records are not used, and delegation still points at the old one (#1992).
var dnsCreateGate = map[string]string{
	"aws":     "cloud_dns_enabled",
	"azure":   "azure_dns_enabled",
	"alibaba": "alidns_enabled",
}

func dnsConfig(zoneID string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName:      "demo",
		EnvironmentStage: "prod",
		DNS: types.ProjectDNSConfig{
			Enabled:    true,
			DomainName: "example.com",
			ZoneID:     zoneID,
		},
	}
}

// An existing zone must SUPPRESS creation on every cloud that creates one.
func TestExistingZoneSuppressesZoneCreation(t *testing.T) {
	for cloud, gate := range dnsCreateGate {
		p, err := NewCloudProvider(cloud)
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		got, ok := p.ProviderTfvars(dnsConfig("my-existing-zone"))[gate]
		if !ok {
			t.Errorf("%s: %q was never emitted", cloud, gate)
			continue
		}
		if b, _ := got.(bool); b {
			t.Errorf("%s: %q is true with an existing zone id — the template would create a SECOND zone", cloud, gate)
		}
	}
}

// …and with no existing zone, creation must still happen, or the fix has simply disabled DNS.
func TestNoExistingZoneStillCreatesOne(t *testing.T) {
	for cloud, gate := range dnsCreateGate {
		p, err := NewCloudProvider(cloud)
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		got, ok := p.ProviderTfvars(dnsConfig(""))[gate]
		if !ok {
			t.Errorf("%s: %q was never emitted", cloud, gate)
			continue
		}
		if b, _ := got.(bool); !b {
			t.Errorf("%s: %q is false with no zone id — DNS would never be provisioned at all", cloud, gate)
		}
	}
}

// DNS off must never create a zone, whatever the zone id says.
func TestDNSDisabledCreatesNothing(t *testing.T) {
	for cloud, gate := range dnsCreateGate {
		p, err := NewCloudProvider(cloud)
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		cfg := dnsConfig("")
		cfg.DNS.Enabled = false
		if b, _ := p.ProviderTfvars(cfg)[gate].(bool); b {
			t.Errorf("%s: %q is true while DNS is disabled", cloud, gate)
		}
	}
}
