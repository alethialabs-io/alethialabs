// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"slices"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestEnabled_TheOpsSwitch(t *testing.T) {
	if Enabled(CapabilityOps) {
		t.Error("ops is enabled with nothing set")
	}
	for raw, want := range map[string]bool{
		"1": true, "true": true, "TRUE": true, "yes": true, " on ": true,
		"": false, "0": false, "false": false, "no": false, "off": false, "maybe": false,
	} {
		t.Run(raw, func(t *testing.T) {
			modeEnv(t, map[string]string{OpsEnv: raw})
			if got := Enabled(CapabilityOps); got != want {
				t.Errorf("%s=%q: Enabled = %v, want %v", OpsEnv, raw, got, want)
			}
		})
	}
}

func TestEnabled_AnUnknownCapabilityIsOff(t *testing.T) {
	modeEnv(t, map[string]string{OpsEnv: "1", "ALETHIA_EVERYTHING": "1"})
	if Enabled("everything") || Enabled("") {
		t.Error("a capability capabilities.go does not define is enabled")
	}
}

func TestEnabledCloudProviders_IsTheOfferedSet(t *testing.T) {
	t.Setenv(catalog.HiddenCloudsEnv, "")
	want := []types.CloudProvider{
		types.CloudProviderAws, types.CloudProviderGcp, types.CloudProviderAzure, types.CloudProviderHetzner,
	}
	if got := EnabledCloudProviders(); !slices.Equal(got, want) {
		t.Errorf("EnabledCloudProviders() = %v, want %v", got, want)
	}
	if !CloudEnabled("hetzner") || CloudEnabled("alibaba") || CloudEnabled("nowhere") {
		t.Errorf("CloudEnabled: hetzner=%v alibaba=%v nowhere=%v",
			CloudEnabled("hetzner"), CloudEnabled("alibaba"), CloudEnabled("nowhere"))
	}
	if got := enabledCloudList(); got != "AWS, GCP, Azure and Hetzner" {
		t.Errorf("enabledCloudList() = %q", got)
	}
}

func TestEnabledCloudProviders_AReEnabledCloudJoinsInCatalogOrder(t *testing.T) {
	t.Setenv(catalog.HiddenCloudsEnv, "alibaba")
	if !CloudEnabled("alibaba") {
		t.Fatal("a re-enabled cloud is not enabled")
	}
	if got := enabledCloudNames(); !slices.Equal(got, []string{"AWS", "GCP", "Azure", "Alibaba", "Hetzner"}) {
		t.Errorf("enabledCloudNames() = %v", got)
	}
}

func TestJoinWithAnd(t *testing.T) {
	for _, tc := range []struct {
		names []string
		want  string
	}{
		{nil, ""},
		{[]string{"AWS"}, "AWS"},
		{[]string{"AWS", "GCP"}, "AWS and GCP"},
		{[]string{"AWS", "GCP", "Azure"}, "AWS, GCP and Azure"},
	} {
		if got := joinWithAnd(tc.names); got != tc.want {
			t.Errorf("joinWithAnd(%v) = %q, want %q", tc.names, got, tc.want)
		}
	}
}
