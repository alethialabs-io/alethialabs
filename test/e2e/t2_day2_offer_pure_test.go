// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure unit tests for the day-2 offer posture classifier (#1440). No cloud, no token, no
// e2e_t2 tag — ci.yml runs these via `cd test/e2e && GOWORK=off go test ./...`, so the day-2
// gate is exercised on every PR (it is live code, not a dormant harness).
package e2e

import (
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// day2Managed builds a managed resource_change with the given actions.
func day2Managed(addr, typ string, actions ...tfjson.Action) *tfjson.ResourceChange {
	return &tfjson.ResourceChange{
		Address: addr,
		Type:    typ,
		Mode:    tfjson.ManagedResourceMode,
		Change:  &tfjson.Change{Actions: actions},
	}
}

// day2DataSource builds a data-source resource_change (should be ignored by the classifier).
func day2DataSource(addr, typ string, actions ...tfjson.Action) *tfjson.ResourceChange {
	return &tfjson.ResourceChange{
		Address: addr,
		Type:    typ,
		Mode:    tfjson.DataResourceMode,
		Change:  &tfjson.Change{Actions: actions},
	}
}

// day2PlanOf assembles a plan from resource changes.
func day2PlanOf(changes ...*tfjson.ResourceChange) *tfjson.Plan {
	return &tfjson.Plan{ResourceChanges: changes}
}

// Action shorthands (the tfjson constants, aliased for readable fixtures).
var (
	aCreate = tfjson.ActionCreate
	aUpdate = tfjson.ActionUpdate
	aDelete = tfjson.ActionDelete
	aNoop   = tfjson.ActionNoop
)

func TestAnalyzeDay2_UpdateInPlace(t *testing.T) {
	// A postgres version bump: the server updates in place, a parameter group updates in place.
	plan := day2PlanOf(
		day2Managed("aws_db_instance.pg", "aws_db_instance", aUpdate),
		day2Managed("aws_db_parameter_group.pg", "aws_db_parameter_group", aUpdate),
	)
	p, err := AnalyzeDay2(Day2Update, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.Safe {
		t.Fatalf("in-place update must be safe; verdict=%q", p.Verdict)
	}
	if p.Changed != 2 {
		t.Errorf("Changed = %d, want 2", p.Changed)
	}
	if len(p.DataLossHazards) != 0 {
		t.Errorf("DataLossHazards = %+v, want none", p.DataLossHazards)
	}
	if !strings.Contains(p.Verdict, "converges in place") {
		t.Errorf("verdict = %q", p.Verdict)
	}
}

func TestAnalyzeDay2_UpdateForceReplacesStatefulDB(t *testing.T) {
	// An engine-family switch (or any change that forces the DB to replace): [delete, create].
	plan := day2PlanOf(
		day2Managed("aws_db_instance.pg", "aws_db_instance", aDelete, aCreate),
	)
	p, err := AnalyzeDay2(Day2Update, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Safe {
		t.Fatal("force-replacing a stateful DB must NOT be safe")
	}
	if len(p.DataLossHazards) != 1 || p.DataLossHazards[0].Kind != Day2Replace {
		t.Fatalf("DataLossHazards = %+v, want 1 replace", p.DataLossHazards)
	}
	if !strings.Contains(p.Verdict, "data + endpoint loss") {
		t.Errorf("verdict = %q", p.Verdict)
	}
}

func TestAnalyzeDay2_AWSRedisToValkeyIsHazard(t *testing.T) {
	// AWS redis→valkey is a module swap: the replication group is DELETED, a serverless cache
	// is CREATED. The delete of a stateful resource is the data-loss signal (not a replace).
	plan := day2PlanOf(
		day2Managed("module.redis.aws_elasticache_replication_group.this", "aws_elasticache_replication_group", aDelete),
		day2Managed("module.valkey.aws_elasticache_serverless_cache.this", "aws_elasticache_serverless_cache", aCreate),
	)
	p, err := AnalyzeDay2(Day2Resize, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Safe {
		t.Fatal("deleting the redis replication group (redis→valkey swap) must NOT be safe")
	}
	if len(p.DataLossHazards) != 1 || p.DataLossHazards[0].Kind != Day2Delete {
		t.Fatalf("DataLossHazards = %+v, want 1 delete of the replication group", p.DataLossHazards)
	}
	if p.DataLossHazards[0].Type != "aws_elasticache_replication_group" {
		t.Errorf("hazard type = %q", p.DataLossHazards[0].Type)
	}
}

func TestAnalyzeDay2_GCPRedisToValkeyIsHazard(t *testing.T) {
	// GCP redis→valkey swaps google_redis_instance for the SEPARATE google_memorystore_instance.
	plan := day2PlanOf(
		day2Managed("google_redis_instance.cache", "google_redis_instance", aDelete),
		day2Managed("google_memorystore_instance.cache", "google_memorystore_instance", aCreate),
	)
	p, err := AnalyzeDay2(Day2Resize, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Safe {
		t.Fatal("deleting google_redis_instance (redis→valkey swap) must NOT be safe")
	}
	if len(p.DataLossHazards) != 1 || p.DataLossHazards[0].Type != "google_redis_instance" {
		t.Fatalf("DataLossHazards = %+v, want the redis instance delete", p.DataLossHazards)
	}
}

func TestAnalyzeDay2_AzureManagedRedisReplaceIsHazard(t *testing.T) {
	// Azure's template builds `azurerm_managed_redis` — Azure Cache for Redis (azurerm_redis_cache)
	// is retiring and cannot be created any more. While that type was missing from
	// day2StatefulTypes the gate scored this exact plan as SAFE: an unknown type is not stateful, so
	// force-replacing the whole cache reported no hazard at all. The offer-parity generator
	// (apps/console/scripts/check-offer-parity.mjs) now derives gate coverage from the templates and
	// fails on a data-bearing type the gate does not know, which is what surfaced this.
	plan := day2PlanOf(
		day2Managed("module.redis.azurerm_managed_redis.this", "azurerm_managed_redis", aDelete, aCreate),
	)
	p, err := AnalyzeDay2(Day2Update, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Safe {
		t.Fatal("force-replacing azurerm_managed_redis loses the cache — must NOT be safe")
	}
	if len(p.DataLossHazards) != 1 || p.DataLossHazards[0].Type != "azurerm_managed_redis" {
		t.Fatalf("DataLossHazards = %+v, want the managed-redis replace", p.DataLossHazards)
	}
}

func TestAnalyzeDay2_ResizeInPlaceEndpointSurvives(t *testing.T) {
	// A storage grow / capacity bump the provider does in place — the endpoint survives.
	plan := day2PlanOf(
		day2Managed("google_sql_database_instance.pg", "google_sql_database_instance", aUpdate),
	)
	p, err := AnalyzeDay2(Day2Resize, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.Safe {
		t.Fatalf("in-place resize must be safe; verdict=%q", p.Verdict)
	}
}

func TestAnalyzeDay2_NonStatefulReplaceIsSafe(t *testing.T) {
	// Replacing a non-data-bearing resource (a security group) during an update is fine — only
	// STATEFUL replacements/deletions are day-2 hazards.
	plan := day2PlanOf(
		day2Managed("aws_db_instance.pg", "aws_db_instance", aUpdate),
		day2Managed("aws_security_group.db", "aws_security_group", aDelete, aCreate),
	)
	p, err := AnalyzeDay2(Day2Update, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.Safe {
		t.Fatalf("replacing a non-stateful resource must be safe; hazards=%+v", p.DataLossHazards)
	}
	if p.Changed != 2 {
		t.Errorf("Changed = %d, want 2", p.Changed)
	}
}

func TestAnalyzeDay2_DestroyClean(t *testing.T) {
	// Teardown: every managed resource is deleted, including the stateful DB (that is the point).
	plan := day2PlanOf(
		day2Managed("aws_db_instance.pg", "aws_db_instance", aDelete),
		day2Managed("aws_elasticache_replication_group.redis", "aws_elasticache_replication_group", aDelete),
		day2Managed("aws_security_group.db", "aws_security_group", aDelete),
	)
	p, err := AnalyzeDay2(Day2Destroy, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.Safe {
		t.Fatalf("an all-delete teardown must be clean; lingering=%+v", p.Lingering)
	}
	if p.OrphanScanKnown {
		t.Error("OrphanScanKnown must be false — a plan cannot see out-of-state orphans")
	}
	if !strings.Contains(p.Verdict, "clean teardown") {
		t.Errorf("verdict = %q", p.Verdict)
	}
}

func TestAnalyzeDay2_DestroyLingering(t *testing.T) {
	// A teardown that still updates a resource has not gone to zero.
	plan := day2PlanOf(
		day2Managed("aws_db_instance.pg", "aws_db_instance", aDelete),
		day2Managed("aws_iam_role.leftover", "aws_iam_role", aUpdate),
	)
	p, err := AnalyzeDay2(Day2Destroy, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Safe {
		t.Fatal("a teardown with a lingering update must NOT be clean")
	}
	if len(p.Lingering) != 1 || p.Lingering[0].Address != "aws_iam_role.leftover" {
		t.Fatalf("Lingering = %+v, want the iam role", p.Lingering)
	}
}

func TestAnalyzeDay2_DataSourcesAndNoOpIgnored(t *testing.T) {
	plan := day2PlanOf(
		day2DataSource("data.aws_ami.x", "aws_ami", tfjson.ActionRead),
		day2Managed("aws_db_instance.pg", "aws_db_instance", aNoop),
		day2Managed("google_sql_database_instance.pg", "google_sql_database_instance", aUpdate),
	)
	p, err := AnalyzeDay2(Day2Update, plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Changed != 1 {
		t.Fatalf("Changed = %d, want 1 (data source + no-op ignored)", p.Changed)
	}
}

func TestAnalyzeDay2_EmptyPlanIsError(t *testing.T) {
	// A plan with only no-ops / data-source reads has nothing to assert — fail closed.
	plan := day2PlanOf(
		day2Managed("aws_db_instance.pg", "aws_db_instance", aNoop),
		day2DataSource("data.aws_ami.x", "aws_ami", tfjson.ActionRead),
	)
	if _, err := AnalyzeDay2(Day2Update, plan); err == nil {
		t.Fatal("an empty changeset must be an error (vacuity defense)")
	}
}

func TestAnalyzeDay2_NilPlanIsError(t *testing.T) {
	if _, err := AnalyzeDay2(Day2Destroy, nil); err == nil {
		t.Fatal("a nil plan must be an error")
	}
}

func TestIsDay2StatefulType(t *testing.T) {
	stateful := []string{
		"aws_db_instance", "aws_rds_cluster", "aws_elasticache_replication_group",
		"aws_elasticache_serverless_cache", "google_sql_database_instance",
		"google_redis_instance", "google_memorystore_instance",
		"azurerm_postgresql_flexible_server", "azurerm_mysql_flexible_server",
		"azurerm_redis_cache", "azurerm_managed_redis",
		"alicloud_db_instance", "alicloud_kvstore_instance",
	}
	for _, tp := range stateful {
		if !isDay2StatefulType(tp) {
			t.Errorf("%s should be stateful", tp)
		}
	}
	notStateful := []string{
		"aws_db_subnet_group", "aws_db_parameter_group", "aws_security_group",
		"random_id", "google_compute_network", "azurerm_resource_group",
	}
	for _, tp := range notStateful {
		if isDay2StatefulType(tp) {
			t.Errorf("%s should NOT be stateful", tp)
		}
	}
}

func TestClassifyDay2Actions(t *testing.T) {
	cases := []struct {
		name string
		act  tfjson.Actions
		want Day2ChangeKind
	}{
		{"noop", tfjson.Actions{aNoop}, Day2NoOp},
		{"create", tfjson.Actions{aCreate}, Day2Create},
		{"update", tfjson.Actions{aUpdate}, Day2InPlace},
		{"delete", tfjson.Actions{aDelete}, Day2Delete},
		{"replace-delete-create", tfjson.Actions{aDelete, aCreate}, Day2Replace},
		{"replace-create-delete", tfjson.Actions{aCreate, aDelete}, Day2Replace},
	}
	for _, c := range cases {
		if got := classifyDay2Actions(c.act); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
