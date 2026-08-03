// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// nosqlConfig is a ProjectConfig carrying nothing but the NoSQL tables under test. Everything else
// stays zero-valued on purpose: a failure in these tests can then only be about the NoSQL lane.
func nosqlConfig(tables ...types.ProjectNosqlConfig) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName:      "alethia",
		EnvironmentStage: "staging",
		Region:           "europe-west3",
		NosqlTables:      tables,
	}
}

// ---------------------------------------------------------------------------
// GCP — Firestore point-in-time recovery (#1815)
// ---------------------------------------------------------------------------

// The canvas's point-in-time-recovery switch reaches a GCP tfvar in BOTH positions, and the tfvar
// is present either way.
//
// Presence alone is not the invariant, and asserting only the ON position is how a switch that is
// hardcoded on passes for a switch that works. The OFF position is the half that matters most here:
// `POINT_IN_TIME_RECOVERY_DISABLED` is Firestore's own default and therefore the value every
// database already in the field carries, so a `false` that failed to arrive as an explicit `false`
// would be indistinguishable from the switch never having been wired at all.
//
// What this replaces is a builder that read the field into a list nobody assigned to a tfvar —
// `buildFirestoreDatabases`, kept alive only by its own unit test, and the canonical false positive
// the offer-parity carrier tracer was written to catch. It is deleted, along with that test.
func TestGCPProviderTfvars_FirestorePITR_BothPositions(t *testing.T) {
	p := &gcpProvider{}

	on := p.ProviderTfvars(nosqlConfig(types.ProjectNosqlConfig{Name: "sessions", PointInTimeRecovery: true}))
	got, ok := on["firestore_point_in_time_recovery"]
	if !ok {
		t.Fatal("firestore_point_in_time_recovery is absent from the GCP tfvars — the switch never reaches the plan")
	}
	if got != true {
		t.Errorf("firestore_point_in_time_recovery = %v, want true", got)
	}

	off := p.ProviderTfvars(nosqlConfig(types.ProjectNosqlConfig{Name: "sessions", PointInTimeRecovery: false}))
	got, ok = off["firestore_point_in_time_recovery"]
	if !ok {
		t.Fatal("firestore_point_in_time_recovery must be emitted in the OFF position too — an omitted key hands the template its default, which is the same shape as an unwired switch")
	}
	if got != false {
		t.Errorf("firestore_point_in_time_recovery = %v, want false", got)
	}
}

// PITR is a property of the DATABASE, and GCP allows one Firestore database per project — what the
// canvas calls a "table" is a collection inside it. So the per-table switch is aggregated with ANY:
// one table asking for recovery turns it on for all of them.
//
// The all-off case is asserted alongside, because an aggregation that returned true unconditionally
// would satisfy the any-on case on its own.
func TestGCPProviderTfvars_FirestorePITR_AggregatesWithAny(t *testing.T) {
	p := &gcpProvider{}

	mixed := p.ProviderTfvars(nosqlConfig(
		types.ProjectNosqlConfig{Name: "a", PointInTimeRecovery: false},
		types.ProjectNosqlConfig{Name: "b", PointInTimeRecovery: true},
		types.ProjectNosqlConfig{Name: "c", PointInTimeRecovery: false},
	))
	if mixed["firestore_point_in_time_recovery"] != true {
		t.Errorf("one table asking for recovery must turn it on for the database, got %v", mixed["firestore_point_in_time_recovery"])
	}

	none := p.ProviderTfvars(nosqlConfig(
		types.ProjectNosqlConfig{Name: "a"},
		types.ProjectNosqlConfig{Name: "b"},
	))
	if none["firestore_point_in_time_recovery"] != false {
		t.Errorf("no table asking for recovery must leave it off, got %v", none["firestore_point_in_time_recovery"])
	}
}

// A project with no NoSQL tables builds no Firestore database, and must not ask for recovery on one.
func TestGCPProviderTfvars_FirestorePITR_NoTables(t *testing.T) {
	tfvars := (&gcpProvider{}).ProviderTfvars(nosqlConfig())

	if tfvars["create_firestore"] != false {
		t.Errorf("create_firestore = %v, want false with no NoSQL tables", tfvars["create_firestore"])
	}
	if tfvars["firestore_point_in_time_recovery"] != false {
		t.Errorf("firestore_point_in_time_recovery = %v, want false with no NoSQL tables", tfvars["firestore_point_in_time_recovery"])
	}
}

// ---------------------------------------------------------------------------
// Alibaba — Tablestore primary keys (#1836)
// ---------------------------------------------------------------------------

// A Tablestore table is emitted under the key the module actually reads, carrying the key the user
// chose (#1836).
//
// The defect this pins was silent end to end. `buildOTSTables` emitted a scalar `primary_key` plus
// a `primary_key_type`, while modules/ots/main.tf read
// `try(each.value.primary_keys, [{ name = "id", type = "String" }])` — a LIST under a different
// name. `try` swallowed the miss, `tables` was `list(any)` so nothing typed rejected the shape, and
// the plan came out clean: every Tablestore table in every Alibaba project was built on the
// fallback key `id`/`String` while the console displayed the user's own choice.
//
// So the assertion is about the NAME OF THE KEY as much as its value, and it asserts the old
// spellings are GONE — a builder that emitted both would satisfy a value check and leave the
// template free to keep reading the wrong one.
func TestAlibabaProviderTfvars_OTSTablesUsePrimaryKeysList(t *testing.T) {
	tfvars := (&alibabaProvider{}).ProviderTfvars(nosqlConfig(types.ProjectNosqlConfig{
		Name:             "sessions",
		PartitionKey:     "tenant_id",
		PartitionKeyType: "S",
	}))

	tables, ok := tfvars["ots_tables"].([]map[string]interface{})
	if !ok || len(tables) != 1 {
		t.Fatalf("ots_tables = %#v, want one table", tfvars["ots_tables"])
	}
	entry := tables[0]

	if _, stale := entry["primary_key"]; stale {
		t.Error("ots_tables still emits the scalar `primary_key`, which the module does not read — #1836")
	}
	if _, stale := entry["primary_key_type"]; stale {
		t.Error("ots_tables still emits `primary_key_type`, which the module does not read — #1836")
	}

	keys, ok := entry["primary_keys"].([]map[string]interface{})
	if !ok || len(keys) != 1 {
		t.Fatalf("primary_keys = %#v, want one key under the name modules/ots/main.tf reads", entry["primary_keys"])
	}
	if keys[0]["name"] != "tenant_id" {
		t.Errorf("primary key name = %v, want tenant_id (the module's old fallback was id)", keys[0]["name"])
	}
	if keys[0]["type"] != "String" {
		t.Errorf("primary key type = %v, want String", keys[0]["type"])
	}
}

// The key TYPE travelled on the same broken path as the name, so pinning only the name would leave
// half of #1836 in place. These are the exact strings Tablestore accepts, produced from the
// cloud-neutral S/N/B the canvas stores.
func TestAlibabaProviderTfvars_OTSPrimaryKeyTypesAreTablestoreSpellings(t *testing.T) {
	for _, tc := range []struct {
		canvas types.NosqlKeyType
		want   string
	}{
		{"S", "String"},
		{"N", "Integer"},
		{"B", "Binary"},
		{"", "String"}, // unset falls back to Tablestore's string type, not to an empty type
	} {
		tfvars := (&alibabaProvider{}).ProviderTfvars(nosqlConfig(types.ProjectNosqlConfig{
			Name:             "t",
			PartitionKey:     "pk",
			PartitionKeyType: tc.canvas,
		}))
		keys := tfvars["ots_tables"].([]map[string]interface{})[0]["primary_keys"].([]map[string]interface{})
		if keys[0]["type"] != tc.want {
			t.Errorf("canvas key type %q became %v, want %s", tc.canvas, keys[0]["type"], tc.want)
		}
	}
}

// Each table keeps its own key. A `for` loop that reused the first entry would pass every
// single-table assertion above.
func TestAlibabaProviderTfvars_OTSTablesKeepTheirOwnKeys(t *testing.T) {
	tfvars := (&alibabaProvider{}).ProviderTfvars(nosqlConfig(
		types.ProjectNosqlConfig{Name: "sessions", PartitionKey: "tenant_id", PartitionKeyType: "S"},
		types.ProjectNosqlConfig{Name: "events", PartitionKey: "event_seq", PartitionKeyType: "N"},
	))

	tables := tfvars["ots_tables"].([]map[string]interface{})
	if len(tables) != 2 {
		t.Fatalf("ots_tables = %#v, want two tables", tables)
	}
	for i, want := range []struct{ name, key, keyType string }{
		{"sessions", "tenant_id", "String"},
		{"events", "event_seq", "Integer"},
	} {
		keys := tables[i]["primary_keys"].([]map[string]interface{})
		if tables[i]["name"] != want.name || keys[0]["name"] != want.key || keys[0]["type"] != want.keyType {
			t.Errorf("table %d = %#v, want %s keyed on %s/%s", i, tables[i], want.name, want.key, want.keyType)
		}
	}
}
