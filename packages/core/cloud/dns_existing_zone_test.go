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
//
// THIS MAP USED TO BE THE BUG. It listed three clouds. gcp and hetzner were simply absent, so the
// three tests below iterated a map that did not mention them and passed — while gcp had no gate at
// all (#2294) and emitted `cloud_dns_enabled: config.DNS.Enabled` flat. A parity test whose
// coverage is a hand-written literal proves parity only across the rows somebody remembered, and
// reads exactly like one that proves it everywhere. TestEveryProvisionableCloudDeclaresItsDNSGate
// below is what stops that recurring: the map must now cover every cloud that provisions at all.
var dnsCreateGate = map[string]string{
	"aws":     "cloud_dns_enabled",
	"gcp":     "cloud_dns_enabled",
	"azure":   "azure_dns_enabled",
	"alibaba": "alidns_enabled",
	"hetzner": "cloud_dns_enabled",
}

// The tfvar each cloud uses to CARRY the zone you brought. Suppressing creation is only half the
// fix: if the identifier never reaches the template, "attach to a zone you already own" degrades
// from creating the wrong thing to creating nothing — a silent no-op, which is harder to notice
// than the bug it replaced. TestExistingZoneIsStillCarried pins the other half.
var dnsCarryVar = map[string]string{
	"aws":     "dns_hosted_zone",
	"gcp":     "cloud_dns_zone_name",
	"azure":   "azure_dns_zone_name",
	"alibaba": "alidns_zone_name",
	"hetzner": "dns_hosted_zone",
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

// Suppressing creation is only half of "attach to a zone you already own". The identifier must
// still REACH the template, or the offer silently becomes a no-op.
func TestExistingZoneIsStillCarried(t *testing.T) {
	for cloud, carry := range dnsCarryVar {
		p, err := NewCloudProvider(cloud)
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		got, ok := p.ProviderTfvars(dnsConfig("my-existing-zone"))[carry]
		if !ok {
			t.Errorf("%s: %q was never emitted — the brought zone reaches the template nowhere", cloud, carry)
			continue
		}
		if s, _ := got.(string); s != "my-existing-zone" {
			t.Errorf("%s: %q = %q, want the zone the caller brought — suppressing creation without carrying the id is a silent no-op", cloud, carry, s)
		}
	}
}

// The guard on the two maps above. Every cloud that can provision AT ALL must declare both its
// create gate and its carry variable, so a cloud cannot be quietly absent from a parity test that
// reads as exhaustive. Derived from the generated enum SSOT (types.AllCloudProviders), not from a
// second hand-written list — which would only move the same hole one file across.
func TestEveryProvisionableCloudDeclaresItsDNSGate(t *testing.T) {
	var provisionable []string
	for _, cp := range types.AllCloudProviders {
		if _, err := NewCloudProvider(string(cp)); err != nil {
			continue // "coming soon" — connectable, but provisions nothing to gate.
		}
		provisionable = append(provisionable, string(cp))
	}
	if len(provisionable) == 0 {
		t.Fatal("no provisionable clouds found — this guard would pass vacuously")
	}
	for _, cloud := range provisionable {
		if _, ok := dnsCreateGate[cloud]; !ok {
			t.Errorf("cloud %q provisions but declares no DNS create gate — it is invisible to every test in this file", cloud)
		}
		if _, ok := dnsCarryVar[cloud]; !ok {
			t.Errorf("cloud %q provisions but declares no DNS carry variable", cloud)
		}
	}
	// …and the reverse, so a removed cloud leaves no dead row claiming coverage.
	for cloud := range dnsCreateGate {
		if _, err := NewCloudProvider(cloud); err != nil {
			t.Errorf("dnsCreateGate names %q, which does not provision — a stale row that covers nothing", cloud)
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
