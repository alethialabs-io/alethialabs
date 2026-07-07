// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestInspectClusterNoClusterName(t *testing.T) {
	// No provisioned cluster name → nothing to inspect (returns nil, nil, never panics).
	vc := &types.ProjectConfig{}
	addon, sec := InspectCluster(context.Background(), vc, "aws", io.Discard, io.Discard)
	if addon != nil || sec != nil {
		t.Errorf("expected (nil, nil) without a cluster name, got (%v, %v)", addon, sec)
	}
}

func TestInspectClusterNilConfig(t *testing.T) {
	addon, sec := InspectCluster(context.Background(), nil, "aws", io.Discard, io.Discard)
	if addon != nil || sec != nil {
		t.Errorf("expected (nil, nil) for a nil config, got (%v, %v)", addon, sec)
	}
}

func TestClusterNameOutputKey(t *testing.T) {
	cases := map[string]string{
		"aws":     "eks_cluster_name",
		"gcp":     "gke_cluster_name",
		"azure":   "aks_cluster_name",
		"unknown": "eks_cluster_name", // default
	}
	for provider, want := range cases {
		if got := clusterNameOutputKey(provider); got != want {
			t.Errorf("clusterNameOutputKey(%q) = %q, want %q", provider, got, want)
		}
	}
}
