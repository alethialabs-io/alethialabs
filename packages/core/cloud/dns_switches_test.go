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
	// certInCluster marks a cloud whose managed certificate is issued IN-CLUSTER by cert-manager
	// rather than by OpenTofu, so it emits NO certificate tfvar at all (#1825).
	//
	// The cell still names certVar, and the assertions below flip to demanding its ABSENCE rather
	// than skipping. Skipping would let the tfvar quietly come back: it would reach a template that
	// no longer declares it, OpenTofu would drop it at plan time, and the offer-parity guard would
	// still trace the emit and score the cell as carried — a green cell for a value that never
	// reaches a plan. Asserting absence is what makes that un-regressable.
	certInCluster bool
	// wafWithdrawn marks a cloud whose WAF offer is withdrawn, so it emits NO WAF tfvar at all
	// (#1841 — Alibaba's WAF 3.0 instance is an ACCOUNT-level purchase a project cannot own).
	//
	// Exactly the `certInCluster` shape above, and for exactly its reason: the cell still names
	// wafVar and the assertions flip to demanding its ABSENCE rather than skipping. Skipping would
	// let the tfvar quietly come back — it would reach a template that no longer declares it,
	// OpenTofu would drop it at plan time, and the offer-parity guard would still trace the emit and
	// score the cell as carried, contradicting the documented exclusion while staying green.
	wafWithdrawn bool
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
			cloud:         "gcp",
			build:         (&gcpProvider{}).ProviderTfvars,
			certVar:       "cloud_dns_managed_certificate",
			wafVar:        "cloud_armor_enabled",
			certKey:       "managed_certificate",
			wafKey:        "cloud_armor",
			certInCluster: true,
		},
		{
			cloud:         "azure",
			build:         (&azureProvider{}).ProviderTfvars,
			certVar:       "azure_managed_certificate",
			wafVar:        "azure_waf_enabled",
			certKey:       "managed_certificate",
			wafKey:        "azure_waf",
			certInCluster: true,
		},
		{
			cloud:   "alibaba",
			build:   (&alibabaProvider{}).ProviderTfvars,
			certVar: "alidns_managed_certificate",
			// The offer is WITHDRAWN here (#1841): WAF 3.0 is an account-level purchase, so a
			// project cannot own one without releasing the whole account's firewall when it is
			// destroyed. The certificate switch is unaffected and still carries, which is why the
			// row stays in the table rather than leaving it.
			wafVar:       "application_waf_enabled",
			certKey:      "managed_certificate",
			wafKey:       "application_waf",
			wafWithdrawn: true,
		},
	}
}

// assertCert asserts the cloud's certificate tfvar — its VALUE on the clouds that carry one, and
// its ABSENCE on the clouds where cert-manager issues in-cluster.
func assertCert(t *testing.T, c dnsSwitchCell, tf map[string]interface{}, want bool) {
	t.Helper()
	if c.certInCluster {
		if v, ok := tf[c.certVar]; ok {
			t.Errorf("%s: %s = %v, want it ABSENT — this cloud issues the certificate in-cluster and its template declares no such variable", c.cloud, c.certVar, v)
		}
		return
	}
	assertEq(t, tf, c.certVar, want)
}

// assertWaf asserts the cloud's WAF tfvar — its VALUE on the clouds that carry one, and its ABSENCE
// on the clouds whose offer is withdrawn.
func assertWaf(t *testing.T, c dnsSwitchCell, tf map[string]interface{}, want bool) {
	t.Helper()
	if c.wafWithdrawn {
		if v, ok := tf[c.wafVar]; ok {
			t.Errorf("%s: %s = %v, want it ABSENT — the WAF offer is withdrawn on this cloud (#1841) and its template declares no such variable", c.cloud, c.wafVar, v)
		}
		return
	}
	assertEq(t, tf, c.wafVar, want)
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
				assertCert(t, c, tf, false)
				assertWaf(t, c, tf, false)
			})

			t.Run("typed fields carry", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{ManagedCertificate: true, WafEnabled: true},
				})
				assertCert(t, c, tf, true)
				assertWaf(t, c, tf, true)
			})

			t.Run("each switch is independent", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{ManagedCertificate: true},
				})
				assertCert(t, c, tf, true)
				assertWaf(t, c, tf, false)
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
		// The legacy provider_config keys are still set on EVERY cloud, including the ones whose
		// offer is withdrawn or issued in-cluster. That is the point: the override is the loudest
		// way a caller can ask, and `assertCert`/`assertWaf` demand the tfvar stay absent anyway.
		overrides := func(cert, waf any) map[string]any {
			return map[string]any{c.certKey: cert, c.wafKey: waf}
		}
		t.Run(c.cloud, func(t *testing.T) {
			t.Run("override forces off", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{
						ManagedCertificate: true,
						WafEnabled:         true,
						ProviderConfig:     overrides(false, false),
					},
				})
				assertCert(t, c, tf, false)
				assertWaf(t, c, tf, false)
			})

			t.Run("override forces on", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{ProviderConfig: overrides(true, true)},
				})
				assertCert(t, c, tf, true)
				assertWaf(t, c, tf, true)
			})

			t.Run("wrong-typed override is ignored, typed field survives", func(t *testing.T) {
				tf := c.build(&types.ProjectConfig{
					DNS: types.ProjectDNSConfig{
						ManagedCertificate: true,
						WafEnabled:         true,
						ProviderConfig:     overrides("true", 1),
					},
				})
				assertCert(t, c, tf, true)
				assertWaf(t, c, tf, true)
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

// Hetzner carries neither the CERTIFICATE nor the WAF switch, and that is a decision rather than a
// gap: TLS is issued in-cluster by cert-manager and Hetzner sells no WAF. Both cells are documented
// exclusions in infra/offer-exclusions.yaml; this pins the behaviour so a future change to the
// Hetzner provider cannot quietly start emitting them.
//
// It says nothing about DNS as a whole. Since #1816 Hetzner DOES carry `cloud_dns_enabled` /
// `dns_main_domain` / `dns_hosted_zone` and creates an `hcloud_zone` — see
// TestHetznerProvider_ProviderTfvars_DNS. The distinction is the point: a zone is not a certificate
// and it is not a WAF, so building one buys the other two cells nothing.
func TestHetznerProviderTfvars_CarriesNoCertificateOrWafSwitches(t *testing.T) {
	tf := (&hetznerProvider{}).ProviderTfvars(&types.ProjectConfig{
		DNS: types.ProjectDNSConfig{ManagedCertificate: true, WafEnabled: true},
	})
	for _, key := range []string{
		"acm_certificate_enable", "application_waf_enabled", "cloud_dns_managed_certificate",
		"cloud_armor_enabled", "azure_managed_certificate", "azure_waf_enabled",
		"alidns_managed_certificate",
	} {
		if _, ok := tf[key]; ok {
			t.Errorf("hetzner emitted %q — it has no certificate or WAF template variable to carry it to", key)
		}
	}
}

// Alibaba carries the CERTIFICATE switch and not the WAF one, and the asymmetry is the decision.
//
// `alicloud_wafv3_instance` takes no arguments at all — four computed attributes and a `timeouts`
// block — and its create/delete are CreatePostpaidInstance/ReleaseInstance. Nothing distinguishes
// two instances, so the purchase is ACCOUNT-scoped at the API level rather than by modelling
// preference, and a per-project state model cannot own it: destroying one project would release the
// account's firewall out from under every other project sharing it. The offer is withdrawn (#1841).
//
// If this test starts failing, the exclusion in infra/offer-exclusions.yaml has been contradicted by
// code — and `check:offer-parity` will say so too, as a false ceiling. Both switches are fed ON,
// including the legacy provider_config override, because the withdrawal has to hold against the
// loudest input a caller can produce, not merely against the default.
func TestAlibabaProviderTfvars_CarriesNoWafSwitch(t *testing.T) {
	tf := (&alibabaProvider{}).ProviderTfvars(&types.ProjectConfig{
		DNS: types.ProjectDNSConfig{
			ManagedCertificate: true,
			WafEnabled:         true,
			ProviderConfig:     map[string]any{"application_waf": true},
		},
	})

	// The certificate half still works — this is a WAF withdrawal, not a DNS one.
	assertEq(t, tf, "alidns_managed_certificate", true)

	for _, key := range []string{
		"application_waf_enabled", "cloudfront_waf_enabled", "cloud_armor_enabled", "azure_waf_enabled",
	} {
		if _, ok := tf[key]; ok {
			t.Errorf("alibaba emitted %q — the WAF offer is withdrawn on this cloud (#1841) and the template declares no variable to carry it to", key)
		}
	}

	// The reserved key must not fall through verbatim either. Unreserving it would hand the root
	// template an undeclared tfvar, which OpenTofu drops with a warning — indistinguishable, to the
	// user, from a switch that worked.
	if _, ok := tf["application_waf"]; ok {
		t.Error("reserved key application_waf leaked into alibaba tfvars verbatim")
	}
}
