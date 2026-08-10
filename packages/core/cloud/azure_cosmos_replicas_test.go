// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestAzureCosmos_GlobalReplicasReachTheCollectionsTfvar pins the carrier half of #2158: the
// regions the canvas collects per table must survive into `cosmos_db_collections`, where the
// template folds them into one account-level union (Cosmos replicates per ACCOUNT — the
// point_in_time_recovery shape; the union, dedup, priorities and the serverless flip are template
// facts asserted by checks_cosmos.tftest.hcl off the resource).
//
// Deliberately UNLIKE the AWS carry, TableType is not consulted: global-vs-standard is a DynamoDB
// distinction that decides nothing on Cosmos — every container replicates with its account — so
// any table's chosen regions join the union. Gating on TableType here would also mint a
// `gated-carrier` cell for a field the azure provider otherwise never reads.
func TestAzureCosmos_GlobalReplicasReachTheCollectionsTfvar(t *testing.T) {
	tf := (&azureProvider{}).ProviderTfvars(&types.ProjectConfig{
		ProjectName: "acme",
		NosqlTables: []types.ProjectNosqlConfig{
			{Name: "g", TableType: "global", PartitionKey: "/pk", GlobalReplicas: []string{"northeurope", "francecentral"}},
			{Name: "r", TableType: "standard", PartitionKey: "/pk", GlobalReplicas: []string{"northeurope"}},
			{Name: "g2", TableType: "global", PartitionKey: "/pk"},
		},
	})

	collections, ok := tf["cosmos_db_collections"].([]map[string]interface{})
	if !ok || len(collections) != 3 {
		t.Fatalf("cosmos_db_collections = %#v, want one entry per table", tf["cosmos_db_collections"])
	}

	reps, _ := collections[0]["global_replicas"].([]string)
	if len(reps) != 2 || reps[0] != "northeurope" || reps[1] != "francecentral" {
		t.Errorf("global table replicas = %v, want the regions the canvas collected", collections[0]["global_replicas"])
	}
	// A standard table's regions count too — on Cosmos the account replicates every container, so
	// the DynamoDB table-type distinction must not silently drop a table's request.
	reps2, _ := collections[1]["global_replicas"].([]string)
	if len(reps2) != 1 || reps2[0] != "northeurope" {
		t.Errorf("a standard table's replicas must still reach the account union on Azure: %#v", collections[1])
	}
	// Unset emits NOTHING rather than an empty list, so an old snapshot's plan is byte-identical —
	// the same absence convention as the AWS carry, and what keeps the serverless flip impossible
	// to trigger by default.
	if _, present := collections[2]["global_replicas"]; present {
		t.Errorf("a table with no chosen regions must emit nothing, not an empty override: %#v", collections[2])
	}
}
