// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestGCPProviderTfvars_DeletedLogRetentionKnobIsStripped pins the stored-value half of deleting
// `gke_log_retention_days` (#4320, maintainer ruling 2026-09-23).
//
// The knob was declared, reachable through the cluster's provider_config, and read by nothing — GKE
// has no per-cluster log retention. The template no longer declares it, but a value a user already
// saved still sits in `project_cluster.provider_config`, and the cluster merge is root-shaped: left
// unreserved, it would be emitted as a root tfvar for a variable that does not exist. It is reserved
// so the merge skips it, the same as `managed_certificate` on GCP's DNS and `log_exports` on Azure's
// database.
func TestGCPProviderTfvars_DeletedLogRetentionKnobIsStripped(t *testing.T) {
	p := &gcpProvider{}
	tfvars := p.ProviderTfvars(&types.ProjectConfig{
		ProjectName: "acme",
		Cluster: types.ProjectClusterConfig{ProviderConfig: map[string]any{
			"gke_log_retention_days": float64(30),
			// A live knob beside it, so the test fails if the merge stopped running at all rather
			// than only if this key leaked.
			"gke_enable_private_endpoint": true,
		}},
	})
	if v, leaked := tfvars["gke_log_retention_days"]; leaked {
		t.Errorf("gke_log_retention_days = %v leaked into tfvars; the template deleted the variable (#4320)", v)
	}
	if tfvars["gke_enable_private_endpoint"] != true {
		t.Errorf("the cluster passthrough stopped merging — gke_enable_private_endpoint = %v", tfvars["gke_enable_private_endpoint"])
	}
}
