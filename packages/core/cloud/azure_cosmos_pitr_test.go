// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestAzureCosmos_PITRIsContinuousBackupNotAnalyticalStorage pins the fix for #1838.
//
// The azure Cosmos entry builder used to answer `PointInTimeRecovery` with
// `analytical_storage_enabled = true`. Analytical storage is Synapse Link column storage — a
// different product, separately billed, and not a backup — so a user who asked for recoverability
// was charged for a feature they never asked for and got no recoverability at all. Point-in-time
// restore on Cosmos is `backup { type = "Continuous" }` on the account, which nothing set.
//
// Two halves, and both are load-bearing:
//
//   - the switch must emit a PITR key whose VALUE moves with it. A key merely WRITTEN inside an
//     `if t.PointInTimeRecovery` branch is what the offer-parity guard grades `gated-carrier`: it
//     proves the switch decides whether some key appears, never that the key IS the feature.
//   - the switch must NOT emit `analytical_storage_enabled` on any table, in either position. This
//     is the half that fails against the old code, and it is the actual defect.
func TestAzureCosmos_PITRIsContinuousBackupNotAnalyticalStorage(t *testing.T) {
	got := buildCosmosDBCollections([]types.ProjectNosqlConfig{
		{Name: "recoverable", PartitionKey: "/tenant", PointInTimeRecovery: true},
		{Name: "plain"},
	})
	if len(got) != 2 {
		t.Fatalf("want one entry per table, got %d: %#v", len(got), got)
	}

	// 1. The PITR key exists on BOTH tables and carries the switch's own value. Emitting it only on
	//    the true side would be the `gated-carrier` shape again under a better name.
	if got[0]["point_in_time_recovery"] != true {
		t.Errorf("a table with PITR on must emit point_in_time_recovery = true: %#v", got[0])
	}
	if got[1]["point_in_time_recovery"] != false {
		t.Errorf("a table with PITR off must emit point_in_time_recovery = false, not omit it: %#v", got[1])
	}

	// 2. The billable wrong feature is gone. Absent, not false: the canvas has no analytical-storage
	//    switch, so this builder has no business naming the key at all.
	for i, entry := range got {
		if _, ok := entry["analytical_storage_enabled"]; ok {
			t.Errorf("table %d: the PITR switch must not touch analytical_storage_enabled (Synapse Link is separately billed and is not a backup): %#v", i, entry)
		}
	}
}

// TestAzureCosmos_PITRReachesTheTemplateAsATfvar walks the whole carrier hop: the switch has to
// survive `ProviderTfvars`, not merely `buildCosmosDBCollections`. `cosmos_db_collections` is the
// root tfvar the azure template declares, and a value that never lands there is a switch the plan
// never sees.
func TestAzureCosmos_PITRReachesTheTemplateAsATfvar(t *testing.T) {
	p := &azureProvider{}
	tfvars := p.ProviderTfvars(&types.ProjectConfig{
		ProjectName: "acme",
		NosqlTables: []types.ProjectNosqlConfig{
			{Name: "ledger", PointInTimeRecovery: true},
		},
	})

	if tfvars["create_cosmos_db"] != true {
		t.Fatalf("a project with a NoSQL table must turn Cosmos on: %v", tfvars["create_cosmos_db"])
	}
	collections, ok := tfvars["cosmos_db_collections"].([]map[string]interface{})
	if !ok || len(collections) != 1 {
		t.Fatalf("cosmos_db_collections = %#v, want one collection", tfvars["cosmos_db_collections"])
	}
	if collections[0]["point_in_time_recovery"] != true {
		t.Errorf("the PITR switch must arrive in tfvars as point_in_time_recovery: %#v", collections[0])
	}
	if _, ok := collections[0]["analytical_storage_enabled"]; ok {
		t.Errorf("tfvars must not enable Synapse analytical storage off the back of PITR: %#v", collections[0])
	}
}
