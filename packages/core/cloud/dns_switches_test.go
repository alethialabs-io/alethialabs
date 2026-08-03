// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// dnsSwitchCell is one cloud's answer to the canvas's two DNS switches: the tfvar each one
// becomes, and the provider_config key that has historically fronted it.
type dnsSwitchCell struct {
	cloud string
	build func(*types.ProjectConfig) map[string]interface{}
	// certVar / wafVar are the per-cloud tfvar names. They differ on every cloud, which is
	// precisely why a typed field was needed: `provider_config` could only ever reach ONE
	// spelling, and the canvas has no idea which cloud it is designing for.
	certVar string
	wafVar  string
	// certKey / wafKey are the legacy provider_config keys, kept as per-cloud overrides.
	certKey string
	wafKey  string
}

func dnsSwitchCells() []dnsSwitchCell {
	return []dnsSwitchCell{
		{
			cloud:   "aws",
			build:   (&awsProvider{}).ProviderTfvars,
			certVar: "acm_certificate_enable",
			// REGIONAL, not CLOUDFRONT: no template creates an aws_cloudfront_* resource, so a
			// CLOUDFRONT-scoped web ACL would attach to nothing for as long as that stays true.
			wafVar:  "application_waf_enabled",
			certKey: "acm_certificate",
			wafKey:  "application_waf",
		},
		{
			cloud:   "gcp",
			build:   (&gcpProvider{}).ProviderTfvars,
			certVar: "cloud_dns_managed_certificate",
			wafVar:  "cloud_armor_enabled",
			certKey: "managed_certificate",
			wafKey:  "cloud_armor",
		},
		{
			cloud:   "azure",
			build:   (&azureProvider{}).ProviderTfvars,
			certVar: "azure_managed_certificate",
			wafVar:  "azure_waf_enabled",
			certKey: "managed_certificate",
			wafKey:  "azure_waf",
		},
		{
			cloud:   "alibaba",
			build:   (&alibabaProvider{}).ProviderTfvars,
			certVar: "alidns_managed_certificate",
			wafVar:  "application_waf_enabled",
			certKey: "managed_certificate",
			wafKey:  "application_waf",
		},
	}
}

// The two canvas DNS switches reach every cloud's own tfvar name (#1810).
//
// Before this, `buildConfigSnapshot` hand-enumerated the DNS singleton and simply omitted both
// fields, so they were gone before any provider was asked. The failure was silent on all five
// clouds: the plan came out byte-identical whichever way the user set the switch.
func TestProviderTfvars_DNSSwitchesReachEveryCloud(t *testing.T) {
	for _, c := range dnsSwitchCells() {
		t.Run(c.cloud, func(t *testing.T) {
			t.Run("off by default", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{})
				assertEq(t, tf, c.certVar, false)
				assertEq(t, tf, c.wafVar, false)
			})

			t.Run("typed fields carry", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{ManagedCertificate: true, WafEnabled: true},
				})
				assertEq(t, tf, c.certVar, true)
				assertEq(t, tf, c.wafVar, true)
			})

			t.Run("each switch is independent", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{ManagedCertificate: true},
				})
				assertEq(t, tf, c.certVar, true)
				assertEq(t, tf, c.wafVar, false)
			})
		})
	}
}

// An explicitly-set provider_config key still overrides the canvas switch, in BOTH directions.
//
// The escape hatch predates the switches and is documented as the way to reach a knob the canvas
// does not expose. Seeding the local from the typed field (rather than OR-ing) is what keeps it
// able to turn something back OFF — an OR would have made provider_config write-only.
func TestProviderTfvars_DNSProviderConfigStillOverrides(t *testing.T) {
	for _, c := range dnsSwitchCells() {
		t.Run(c.cloud, func(t *testing.T) {
			t.Run("override forces off", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{
						ManagedCertificate: true,
						WafEnabled:         true,
						ProviderConfig: map[string]any{
							c.certKey: false,
							c.wafKey:  false,
						},
					},
				})
				assertEq(t, tf, c.certVar, false)
				assertEq(t, tf, c.wafVar, false)
			})

			t.Run("override forces on", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{ProviderConfig: map[string]any{
						c.certKey: true,
						c.wafKey:  true,
					}},
				})
				assertEq(t, tf, c.certVar, true)
				assertEq(t, tf, c.wafVar, true)
			})

			t.Run("wrong-typed override is ignored, typed field survives", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{
						ManagedCertificate: true,
						WafEnabled:         true,
						ProviderConfig: map[string]any{
							c.certKey: "true",
							c.wafKey:  1,
						},
					},
				})
				assertEq(t, tf, c.certVar, true)
				assertEq(t, tf, c.wafVar, true)
			})
		})
	}
}

// `waf_enabled` drives the REGIONAL web ACL on AWS and leaves the CloudFront one alone.
//
// AWS is the only cloud with two WAF tfvars fronting different resources, and the canvas has one
// switch. Mapping it to both would double the bill; mapping it to CloudFront would build a web ACL
// in us-east-1 that nothing in this repo can attach, since no template creates a distribution.
// If a CloudFront distribution is ever added, this test is the place that records why the mapping
// was chosen.
func TestAWSProviderTfvars_WafSwitchDrivesRegionalOnly(t *testing.T) {
	tf := (&awsProvider{}).ProviderTfvars(&types.ProjectConfig{
		DNS: types.ProjectDNSConfig{WafEnabled: true},
	})
	assertEq(t, tf, "application_waf_enabled", true)
	assertEq(t, tf, "cloudfront_waf_enabled", false)

	// …and the edge WAF stays reachable for anyone fronting their own distribution.
	tf = (&awsProvider{}).ProviderTfvars(&types.ProjectConfig{
		DNS: types.ProjectDNSConfig{
			WafEnabled:     true,
			ProviderConfig: map[string]any{"cloudfront_waf": true},
		},
	})
	assertEq(t, tf, "application_waf_enabled", true)
	assertEq(t, tf, "cloudfront_waf_enabled", true)
}

// Hetzner carries neither switch, and that is a decision rather than a gap: the template declares
// no DNS variable at all, TLS is issued in-cluster by cert-manager, and Hetzner sells no WAF.
// Both cells are documented exclusions in infra/offer-exclusions.yaml; this pins the behaviour so
// a future change to the Hetzner provider cannot quietly start emitting them.
func TestHetznerProviderTfvars_CarriesNoDNSSwitches(t *testing.T) {
	tf := (&hetznerProvider{}).ProviderTfvars(&types.ProjectConfig{
		DNS: types.ProjectDNSConfig{ManagedCertificate: true, WafEnabled: true},
	})
	for _, key := range []string{
		"acm_certificate_enable", "application_waf_enabled", "cloud_dns_managed_certificate",
		"cloud_armor_enabled", "azure_managed_certificate", "azure_waf_enabled",
		"alidns_managed_certificate",
	} {
		if _, ok := tf[key]; ok {
			t.Errorf("hetzner emitted %q — it has no DNS template variables to carry it to", key)
		}
	}
}
