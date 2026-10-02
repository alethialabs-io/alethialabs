// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// capacityConfig is a minimal valid config carrying one capacity type.
func capacityConfig(capacity types.NodeCapacityType) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "cap",
		Region:      "r",
		Cluster:     types.ProjectClusterConfig{CapacityType: capacity, ProviderConfig: map[string]any{}},
		DNS:         types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Network:     types.ProjectNetworkConfig{ProvisionNetwork: true, CIDRBlock: "10.0.0.0/16"},
	}
}

// TestAWSCapacityTypeReachesTheNodeGroup pins #5266's aws half: the typed field decides
// `eks_ng_capacity_type`, unset leaves the template default (ON_DEMAND), and a provider_config
// passthrough of the same variable cannot override the field — the key is reserved.
func TestAWSCapacityTypeReachesTheNodeGroup(t *testing.T) {
	p := &awsProvider{}
	for capacity, want := range map[types.NodeCapacityType]any{
		types.NodeCapacityTypeSpot:     "SPOT",
		types.NodeCapacityTypeOnDemand: "ON_DEMAND",
	} {
		cfg := capacityConfig(capacity)
		// A conflicting passthrough must lose to the typed field.
		cfg.Cluster.ProviderConfig["eks_ng_capacity_type"] = "BOGUS"
		if got := p.ProviderTfvars(cfg)["eks_ng_capacity_type"]; got != want {
			t.Errorf("capacity_type %q → eks_ng_capacity_type = %v, want %v", capacity, got, want)
		}
	}
	cfg := capacityConfig("")
	cfg.Cluster.ProviderConfig["eks_ng_capacity_type"] = "SPOT"
	if got, present := p.ProviderTfvars(cfg)["eks_ng_capacity_type"]; present {
		t.Errorf("unset capacity_type must leave the template default, got %v (a reserved passthrough leaked)", got)
	}
}

// capacityKnob is one cloud's mapping of capacity_type: the tfvars each value must produce, and the
// keys the typed field owns — the ones a provider_config passthrough must not override.
type capacityKnob struct {
	provider CloudProvider
	spot     map[string]any
	onDemand map[string]any
}

// capacityKnobs is #5315's per-cloud table, written out by hand from each template's variables.tf so
// it is the decision under test and not a restatement of the code.
var capacityKnobs = map[string]capacityKnob{
	"gcp": {
		provider: &gcpProvider{},
		spot:     map[string]any{"gke_spot": true, "gke_preemptible": false},
		onDemand: map[string]any{"gke_spot": false, "gke_preemptible": false},
	},
	"azure": {
		provider: &azureProvider{},
		spot:     map[string]any{"aks_spot_enabled": true},
		onDemand: map[string]any{"aks_spot_enabled": false},
	},
	"alibaba": {
		provider: &alibabaProvider{},
		spot:     map[string]any{"ack_node_capacity_type": "SpotAsPriceGo"},
		onDemand: map[string]any{"ack_node_capacity_type": "NoSpot"},
	},
}

// TestCapacityTypeReachesEachCloudsNativeKnob pins #5315: on gcp, azure and alibaba the typed field
// decides the template's own interruptible-capacity variable, and a conflicting provider_config
// passthrough of that variable loses — the key is owned by the field.
func TestCapacityTypeReachesEachCloudsNativeKnob(t *testing.T) {
	for cloud, knob := range capacityKnobs {
		for capacity, want := range map[types.NodeCapacityType]map[string]any{
			types.NodeCapacityTypeSpot:     knob.spot,
			types.NodeCapacityTypeOnDemand: knob.onDemand,
		} {
			cfg := capacityConfig(capacity)
			for k := range want {
				cfg.Cluster.ProviderConfig[k] = "BOGUS"
			}
			got := knob.provider.ProviderTfvars(cfg)
			for k, v := range want {
				if got[k] != v {
					t.Errorf("%s: capacity_type %q → %s = %v, want %v (a passthrough must not override the field)",
						cloud, capacity, k, got[k], v)
				}
			}
		}
	}
}

// TestUnsetCapacityTypeKeepsTheTemplateDefaultOrALegacyPassthrough: unset writes none of the owned
// keys, so the template default (on-demand) applies — unless the cluster set one by hand through
// provider_config before the field owned it. That value is carried verbatim, because rows are never
// rewritten and dropping it would replace a running Spot pool with on-demand nodes on the next apply.
func TestUnsetCapacityTypeKeepsTheTemplateDefaultOrALegacyPassthrough(t *testing.T) {
	for cloud, knob := range capacityKnobs {
		got := knob.provider.ProviderTfvars(capacityConfig(""))
		for k := range knob.spot {
			if v, present := got[k]; present {
				t.Errorf("%s: unset capacity_type wrote %s = %v; the template default must apply", cloud, k, v)
			}
		}
		cfg := capacityConfig("")
		for k, v := range knob.spot {
			cfg.Cluster.ProviderConfig[k] = v
		}
		got = knob.provider.ProviderTfvars(cfg)
		for k, v := range knob.spot {
			if got[k] != v {
				t.Errorf("%s: a legacy passthrough %s = %v on a cluster with no capacity_type was dropped (got %v)",
					cloud, k, v, got[k])
			}
		}
	}
}

// TestAlibabaSpotKeepsAPriceCap: spot bids the market rate, unless the cluster carries the
// `ack_spot_price_limit` ceilings the template reads only under SpotWithPriceLimit.
func TestAlibabaSpotKeepsAPriceCap(t *testing.T) {
	cfg := capacityConfig(types.NodeCapacityTypeSpot)
	cfg.Cluster.ProviderConfig["ack_spot_price_limit"] = []any{
		map[string]any{"instance_type": "ecs.g6.large", "price_limit": "0.35"},
	}
	if got := (&alibabaProvider{}).ProviderTfvars(cfg)["ack_node_capacity_type"]; got != "SpotWithPriceLimit" {
		t.Errorf("spot with price limits → ack_node_capacity_type = %v, want SpotWithPriceLimit", got)
	}
	cfg.Cluster.ProviderConfig["ack_spot_price_limit"] = []any{}
	if got := (&alibabaProvider{}).ProviderTfvars(cfg)["ack_node_capacity_type"]; got != "SpotAsPriceGo" {
		t.Errorf("spot with an empty price-limit list → %v, want SpotAsPriceGo", got)
	}
}

// TestCapacityTypeIsValidatedPerCloud: spot is accepted wherever a template knob reads it and
// refused on hetzner, which has none; an unknown value is refused everywhere — a stored choice the
// deploy ignores is the defect class #5267 was about.
func TestCapacityTypeIsValidatedPerCloud(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		p, err := NewCloudProvider(provider)
		if err != nil {
			t.Fatal(err)
		}
		for _, ok := range []types.NodeCapacityType{"", types.NodeCapacityTypeOnDemand} {
			if err := p.ValidateConfig(capacityConfig(ok)); err != nil && strings.Contains(err.Error(), "capacity_type") {
				t.Errorf("%s refused capacity_type %q: %v", provider, ok, err)
			}
		}
		err = p.ValidateConfig(capacityConfig(types.NodeCapacityTypeSpot))
		refusedSpot := err != nil && strings.Contains(err.Error(), "capacity_type")
		if provider == "hetzner" {
			if !refusedSpot || !strings.Contains(err.Error(), "no spot or interruptible servers") {
				t.Errorf("hetzner must refuse spot and say why (err=%v)", err)
			}
		} else if refusedSpot {
			t.Errorf("%s refused spot, which its template maps: %v", provider, err)
		}
		if err := p.ValidateConfig(capacityConfig("preemptible")); err == nil || !strings.Contains(err.Error(), "capacity_type") {
			t.Errorf("%s accepted an unknown capacity_type: %v", provider, err)
		}
	}
}

// TestGCPRefusesSpotOnAutopilot: an Autopilot cluster has no node pool, so `gke_spot` would reach
// nothing — the one gcp shape where spot is refused.
func TestGCPRefusesSpotOnAutopilot(t *testing.T) {
	cfg := capacityConfig(types.NodeCapacityTypeSpot)
	cfg.Cluster.ProviderConfig["enable_autopilot"] = true
	err := (&gcpProvider{}).ValidateConfig(cfg)
	if err == nil || !strings.Contains(err.Error(), "Autopilot") {
		t.Errorf("gcp accepted spot on an Autopilot cluster: %v", err)
	}
	cfg.Cluster.CapacityType = types.NodeCapacityTypeOnDemand
	if err := (&gcpProvider{}).ValidateConfig(cfg); err != nil && strings.Contains(err.Error(), "capacity_type") {
		t.Errorf("gcp refused on_demand on Autopilot: %v", err)
	}
}
