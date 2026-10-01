// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"encoding/json"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestBlankClusterTakesTheCatalogDefaults follows the console's "blank project" cluster row (#5268,
// #5266) from the snapshot bytes to the tfvars. That row is written with NO cluster_version and an
// EMPTY instance_types, and buildConfigSnapshot emits `cluster_version: cluster?.cluster_version` —
// so the runner receives an explicit JSON `null`, not an absent key. The test decodes exactly that.
//
// What it pins, per managed cloud:
//   - the null decodes to "" and the version tfvar is the catalog's default_k8s_version, never a
//     literal (this path used to send "1.31", which is in no cloud's k8s_versions);
//   - the instance-type tfvar is ABSENT, so the template default applies — and
//     catalog/template_defaults_test.go holds that default equal to the catalog's default_instance.
func TestBlankClusterTakesTheCatalogDefaults(t *testing.T) {
	cat := catalog.MustLoad()
	const snapshotCluster = `{"cluster_version": null, "instance_types": [], "node_min_size": 2,
		"node_max_size": 5, "node_desired_size": 2, "provider_config": {}}`

	cases := []struct {
		provider, versionKey, instanceKey string
	}{
		{"aws", "eks_cluster_version", "eks_instance_types"},
		{"gcp", "gke_cluster_version", "gke_instance_types"},
		{"azure", "aks_cluster_version", "aks_instance_types"},
		{"alibaba", "ack_cluster_version", "ack_instance_types"},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			var cluster types.ProjectClusterConfig
			if err := json.Unmarshal([]byte(snapshotCluster), &cluster); err != nil {
				t.Fatalf("decode the blank cluster: %v", err)
			}
			if cluster.ClusterVersion != "" {
				t.Fatalf("a null cluster_version decoded to %q, want \"\"", cluster.ClusterVersion)
			}
			p, err := NewCloudProvider(tc.provider)
			if err != nil {
				t.Fatalf("NewCloudProvider(%s): %v", tc.provider, err)
			}
			tfvars := p.ProviderTfvars(&types.ProjectConfig{
				ProjectName: "blank",
				Region:      "r",
				Cluster:     cluster,
				DNS:         types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
			})

			want, ok := cat.DefaultK8sVersion(tc.provider)
			if !ok {
				t.Fatalf("catalog has no default_k8s_version for %s", tc.provider)
			}
			if got := tfvars[tc.versionKey]; got != want {
				t.Errorf("%s = %v, want the catalog default %q", tc.versionKey, got, want)
			}
			if got, present := tfvars[tc.instanceKey]; present {
				t.Errorf("%s = %v, want it ABSENT so the template default (= catalog default) applies", tc.instanceKey, got)
			}
		})
	}
}
