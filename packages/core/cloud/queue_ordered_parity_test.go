// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The invariant, stated once for the whole file: the canvas's `ordered` switch must reach the
// tfvars key each cloud's template reads, carrying the VALUE the user chose, in BOTH positions.
//
// Both positions is the point. A builder that only ever writes the ON position is half a fix — the
// OFF position silently keeps whatever the template defaults to — and it is indistinguishable from
// a whole one to any assertion that checks the key is merely PRESENT. That presence-only shape is
// how registry_parity_test.go passed for months while GCP created zero repositories, and it is the
// shape the offer-parity guard cannot see either: the carrier probe asks whether a key is derived
// from the field, never whether both branches of the field produce different keys.
//
// Alibaba is the one cloud with no carriage assertion, on purpose. `queue:ordered` on Alibaba is a
// documented exclusion (infra/offer-exclusions.yaml): its queue service takes a `fifo` queue type
// and publishes no ordering guarantee behind it, so nothing may carry the switch —
// TestQueueOrdered_AlibabaCarriesNothing pins the ABSENCE, which is the assertion that stops the
// exclusion being quietly contradicted by a later one-line "fix".

// TestQueueOrdered_AWSCarriesFifoQueueBothWays asserts SQS FIFO reaches `fifo_queue` — the name
// modules/sqs-sns reads — as the value the user chose, and that `content_based_deduplication`
// tracks it. Without content-based deduplication a FIFO queue rejects every send that does not
// carry its own MessageDeduplicationId, so the two are one decision, not two.
func TestQueueOrdered_AWSCarriesFifoQueueBothWays(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ordered *bool
		want    bool
	}{
		{"switch on", boolPtr(true), true},
		{"switch off", boolPtr(false), false},
		{"switch untouched", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := buildSQSQueues([]types.ProjectQueueConfig{{Name: "orders", Ordered: tc.ordered}}, nil)
			q, ok := got["orders"].(map[string]interface{})
			if !ok {
				t.Fatalf("no entry for queue 'orders': %#v", got)
			}
			if q["fifo_queue"] != tc.want {
				t.Errorf("fifo_queue = %v, want %v", q["fifo_queue"], tc.want)
			}
			// SQS REFUSES content_based_deduplication on a standard queue, so it can never be set
			// independently of fifo_queue from one canvas boolean.
			if q["content_based_deduplication"] != tc.want {
				t.Errorf("content_based_deduplication = %v, want %v (it must track fifo_queue)", q["content_based_deduplication"], tc.want)
			}
		})
	}
}

// TestQueueOrdered_AWSVisibilityTimeoutIsCarried pins the fix for #1839. The console's visibility
// timeout was emitted into tfvars and read by no argument, so every SQS queue was built at the AWS
// default of 30s whatever the user chose. This asserts the emit; modules/sqs-sns/main.tf owns the
// read, and checks_queue_naming.tftest.hcl proves the read against a plan.
func TestQueueOrdered_AWSVisibilityTimeoutIsCarried(t *testing.T) {
	vis := 120
	got := buildSQSQueues([]types.ProjectQueueConfig{{Name: "orders", VisibilityTimeout: &vis}}, nil)
	q := got["orders"].(map[string]interface{})
	if q["visibility_timeout_seconds"] != 120 {
		t.Errorf("visibility_timeout_seconds = %v, want 120", q["visibility_timeout_seconds"])
	}
}

// TestQueueOrdered_AzureCarriesRequiresSessionBothWays asserts ordered delivery reaches
// `requires_session` — the attribute modules/service-bus declares and reads — in both positions,
// and that an untouched switch still emits the key. The key used to appear only when the switch
// had been set, which made two queues that look identical in the console produce different tfvars.
func TestQueueOrdered_AzureCarriesRequiresSessionBothWays(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ordered *bool
		want    bool
	}{
		{"switch on", boolPtr(true), true},
		{"switch off", boolPtr(false), false},
		{"switch untouched", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := buildServiceBusQueues([]types.ProjectQueueConfig{{Name: "orders", Ordered: tc.ordered}})
			q, ok := got["orders"].(map[string]interface{})
			if !ok {
				t.Fatalf("no entry for queue 'orders': %#v", got)
			}
			v, present := q["requires_session"]
			if !present {
				t.Fatalf("requires_session absent — the tfvars shape must not depend on whether the switch was touched: %#v", q)
			}
			if v != tc.want {
				t.Errorf("requires_session = %v, want %v", v, tc.want)
			}
		})
	}
}

// TestQueueOrdered_GCPCarriesMessageOrderingOnTheSubscription asserts the switch lands on the
// QUEUE's subscription. GCP has no queue primitive, so a canvas queue is a topic with exactly one
// subscription, and `enable_message_ordering` is a property of the subscription — putting it on the
// topic would be a key no resource reads.
func TestQueueOrdered_GCPCarriesMessageOrderingOnTheSubscription(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ordered *bool
		want    bool
	}{
		{"switch on", boolPtr(true), true},
		{"switch off", boolPtr(false), false},
		{"switch untouched", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := buildPubSubTopics(nil, []types.ProjectQueueConfig{{Name: "orders", Ordered: tc.ordered}})
			entry, ok := got["orders"].(map[string]interface{})
			if !ok {
				t.Fatalf("no entry for queue 'orders': %#v", got)
			}
			subs, ok := entry["subscriptions"].([]map[string]interface{})
			if !ok || len(subs) != 1 {
				t.Fatalf("expected exactly one subscription for a queue, got %#v", entry["subscriptions"])
			}
			v, present := subs[0]["enable_message_ordering"]
			if !present {
				t.Fatalf("enable_message_ordering absent from the queue's subscription: %#v", subs[0])
			}
			if v != tc.want {
				t.Errorf("enable_message_ordering = %v, want %v", v, tc.want)
			}
			// The switch must not also land on the topic: google_pubsub_topic has no such argument,
			// so a key there would be carried and read by nothing.
			if _, onTopic := entry["enable_message_ordering"]; onTopic {
				t.Error("enable_message_ordering was placed on the topic; Pub/Sub orders per subscription")
			}
		})
	}
}

// TestQueueOrdered_GCPTopicSubscriptionsAreExplicitlyUnordered pins the OTHER origin of a Pub/Sub
// subscription. A canvas TOPIC is fan-out to subscribers Alethia does not model, so ordering there
// would be a promise about publishers it cannot see. The value is emitted rather than omitted so
// both origins produce the same tfvars shape.
func TestQueueOrdered_GCPTopicSubscriptionsAreExplicitlyUnordered(t *testing.T) {
	got := buildPubSubTopics([]types.ProjectTopicConfig{{
		Name:          "events",
		Subscriptions: []types.TopicSubscription{{Endpoint: "event-processor"}},
	}}, nil)
	entry := got["events"].(map[string]interface{})
	subs := entry["subscriptions"].([]map[string]interface{})
	if len(subs) != 1 {
		t.Fatalf("expected one subscription, got %#v", subs)
	}
	v, present := subs[0]["enable_message_ordering"]
	if !present {
		t.Fatalf("enable_message_ordering absent from a topic subscription: %#v", subs[0])
	}
	if v != false {
		t.Errorf("enable_message_ordering = %v, want false for a topic-derived subscription", v)
	}
}

// TestQueueOrdered_AlibabaCarriesNothing pins the documented exclusion. Alibaba's queue service
// accepts `queue_type = "fifo"` — the argument exists in the pinned provider — and states no
// ordering guarantee, message key, throughput limit or price behind it. Wiring it anyway would put
// a real provider argument behind a promise nobody has made, which is the failure the offer-parity
// guard exists to catch, so the absence is asserted rather than left to be noticed.
//
// If this test starts failing, the exclusion in infra/offer-exclusions.yaml has been contradicted
// by code: either delete the exclusion with the published guarantee that justifies it, or revert.
func TestQueueOrdered_AlibabaCarriesNothing(t *testing.T) {
	for _, ordered := range []*bool{boolPtr(true), boolPtr(false), nil} {
		got := buildMNSQueues([]types.ProjectQueueConfig{{Name: "orders", Ordered: ordered}})
		q, ok := got["orders"].(map[string]interface{})
		if !ok {
			t.Fatalf("no entry for queue 'orders': %#v", got)
		}
		for _, key := range []string{"queue_type", "fifo", "ordered", "fifo_queue"} {
			if v, present := q[key]; present {
				t.Errorf("alibaba emitted %q = %v; queue:ordered is a documented exclusion, not a gap to close quietly", key, v)
			}
		}
	}
}
