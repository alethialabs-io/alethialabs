// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestSnapshotNodeSizeReachesTheInstanceTypeTfvar is #5267's resolver proof: a config snapshot
// carrying `node_size` and an EMPTY `instance_types` — the exact cluster block buildConfigSnapshot
// now emits when the canvas or the CLI sets a size — reaches each cloud's instance-type tfvar as
// the nearest catalog SKU.
//
// It starts from JSON, not from a Go struct literal, on purpose: the bug was that the key never
// rode the wire, and a struct literal would skip the one hop (the `json:"node_size"` tag) that
// decides whether it does.
//
// The expected SKUs are fixed BY DECISION, read off catalog.json's compute inventory, not
// recomputed with NearestInstance — recomputing would pass on any answer the resolver gave.
func TestSnapshotNodeSizeReachesTheInstanceTypeTfvar(t *testing.T) {
	const snapshot = `{
		"project_name": "sized",
		"region": "eu-west-1",
		"cluster": {
			"instance_types": [],
			"node_size": {"vcpu": %VCPU%, "memory_gb": %MEM%},
			"node_min_size": 2,
			"node_max_size": 5,
			"node_desired_size": 2,
			"provider_config": {}
		},
		"dns": {"provider_config": {}}
	}`
	cases := []struct {
		provider string
		vcpu     string
		mem      string
		build    func(*types.ProjectConfig) map[string]interface{}
		tfvar    string
		want     any
	}{
		{"aws", "4", "16", (&awsProvider{}).ProviderTfvars, "eks_instance_types", []string{"t3.xlarge"}},
		{"gcp", "4", "16", (&gcpProvider{}).ProviderTfvars, "gke_instance_types", []string{"e2-standard-4"}},
		{"azure", "4", "16", (&azureProvider{}).ProviderTfvars, "aks_instance_types", []string{"Standard_D4s_v5"}},
		{"alibaba", "4", "16", (&alibabaProvider{}).ProviderTfvars, "ack_instance_types", []string{"ecs.g6.xlarge"}},
		// Hetzner pins ONE server type for the workers, not a list.
		{"hetzner", "4", "8", (&hetznerProvider{}).ProviderTfvars, "worker_server_type", "cax21"},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			raw := strings.NewReplacer("%VCPU%", tc.vcpu, "%MEM%", tc.mem).Replace(snapshot)
			var cfg types.ProjectConfig
			if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
				t.Fatalf("snapshot does not decode: %v", err)
			}
			if cfg.Cluster.NodeSize == nil {
				t.Fatal("node_size did not survive the JSON hop — the snapshot key and the Go tag disagree")
			}
			got := tc.build(&cfg)[tc.tfvar]
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("%s = %#v, want %#v — a node_size snapshot must reach the tfvar as the nearest SKU",
					tc.tfvar, got, tc.want)
			}
		})
	}
}

// TestSnapshotPinnedInstanceTypesStillWin pins the precedence the one-writer rule relies on: a
// legacy row carrying BOTH fields (written before the rule existed — rows are never rewritten)
// keeps deploying exactly the machine type it pinned. Carrying node_size on the snapshot must not
// re-shape it.
func TestSnapshotPinnedInstanceTypesStillWin(t *testing.T) {
	raw := `{"cluster": {"instance_types": ["n2-standard-2"], "node_size": {"vcpu": 8, "memory_gb": 32},
		"provider_config": {}}, "dns": {"provider_config": {}}}`
	var cfg types.ProjectConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("snapshot does not decode: %v", err)
	}
	got := (&gcpProvider{}).ProviderTfvars(&cfg)["gke_instance_types"]
	if !reflect.DeepEqual(got, []string{"n2-standard-2"}) {
		t.Errorf("gke_instance_types = %#v, want the pinned [n2-standard-2]", got)
	}
}
