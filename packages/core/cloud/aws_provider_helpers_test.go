// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"reflect"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestAWSProviderHelperBuilders(t *testing.T) {
	ordered := true
	visibility := 45
	retention := 86400

	queues := buildSQSQueues(
		[]types.ProjectQueueConfig{{
			Name:              "events",
			Ordered:           &ordered,
			VisibilityTimeout: &visibility,
			MessageRetention:  &retention,
			ProviderConfig:    map[string]any{"delay_seconds": float64(7)},
		}},
		nil,
	)
	gotQueue := queues["events"].(map[string]interface{})
	if gotQueue["fifo_queue"] != true {
		t.Fatalf("fifo_queue = %v, want true", gotQueue["fifo_queue"])
	}
	if gotQueue["visibility_timeout_seconds"] != 45 {
		t.Fatalf("visibility_timeout_seconds = %v, want 45", gotQueue["visibility_timeout_seconds"])
	}
	if gotQueue["message_retention_seconds"] != 86400 {
		t.Fatalf("message_retention_seconds = %v, want 86400", gotQueue["message_retention_seconds"])
	}
	if gotQueue["delay_seconds"] != 7 {
		t.Fatalf("delay_seconds = %v, want 7", gotQueue["delay_seconds"])
	}

	topics := buildSNSTopics([]types.ProjectTopicConfig{{
		Name: "alerts",
		Subscriptions: []types.TopicSubscription{{
			Protocol: types.TopicSubscriptionProtocol("https"),
			Endpoint: "https://hooks.example.test/sns",
		}},
	}})
	gotSubs := topics["alerts"].(map[string]interface{})["subscriptions"].([]map[string]string)
	wantSubs := []map[string]string{{"protocol": "https", "endpoint": "https://hooks.example.test/sns"}}
	if !reflect.DeepEqual(gotSubs, wantSubs) {
		t.Fatalf("subscriptions = %#v, want %#v", gotSubs, wantSubs)
	}
}

func TestAWSProviderStorageAndDynamoHelpers(t *testing.T) {
	tables := []types.ProjectNosqlConfig{
		{
			Name:                "sessions",
			PartitionKey:        "pk",
			SortKey:             "sk",
			TableType:           types.NosqlTableType("standard"),
			CapacityMode:        types.NosqlCapacityMode("provisioned"),
			PointInTimeRecovery: true,
		},
		{
			Name:         "ledger",
			PartitionKey: "id",
			TableType:    types.NosqlTableType("global"),
		},
	}

	if !hasGlobalTables(tables) {
		t.Fatal("hasGlobalTables returned false for a global table")
	}
	standard := buildDDBTables(tables, "standard")
	if len(standard) != 1 {
		t.Fatalf("standard tables = %d, want 1", len(standard))
	}
	if standard[0]["billing_mode"] != "PROVISIONED" {
		t.Fatalf("billing_mode = %v, want PROVISIONED", standard[0]["billing_mode"])
	}
	if standard[0]["hash_key_type"] != "S" || standard[0]["range_key_type"] != "S" {
		t.Fatalf("default key types not applied: %#v", standard[0])
	}

	buckets := buildS3Buckets([]types.ProjectStorageBucketConfig{{
		Name:         "assets",
		Versioning:   true,
		PublicAccess: true,
		CorsOrigins:  []string{"https://app.example.test"},
		ProviderConfig: map[string]any{
			"encryption_algorithm": "aws:kms",
		},
	}})
	if len(buckets) != 1 {
		t.Fatalf("buckets = %d, want 1", len(buckets))
	}
	got := buckets[0]
	if got["sse_algorithm"] != "aws:kms" {
		t.Fatalf("sse_algorithm = %v, want aws:kms", got["sse_algorithm"])
	}
	if got["block_public_acls"] != false || got["restrict_public_buckets"] != false {
		t.Fatalf("public bucket flags should not block public access: %#v", got)
	}
	cors := got["cors_configuration"].([]map[string]interface{})
	if len(cors) != 1 {
		t.Fatalf("cors entries = %d, want 1", len(cors))
	}
}

func TestAWSProviderECRNamesMap(t *testing.T) {
	cfg := &types.ProjectConfig{
		ProjectName: "demo",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{
			{Name: "API Images", Provider: "native"},
			{Name: "External Registry", Provider: "dockerhub"},
			{Name: "Worker.Images"},
		},
		Services: []types.ProjectServiceConfig{
			{Name: "Checkout Service", Source: types.ProjectServiceSource{Kind: "repo"}},
			{Name: "Static Image", Source: types.ProjectServiceSource{Kind: "image"}},
		},
	}

	got := buildECRNamesMap(cfg)
	want := map[string]string{
		"API Images":       "api-images",
		"Worker.Images":    "worker-images",
		"Checkout Service": "checkout-service",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildECRNamesMap() = %#v, want %#v", got, want)
	}
}
