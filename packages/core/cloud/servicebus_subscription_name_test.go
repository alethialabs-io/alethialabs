// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// azurerm's own rule for azurerm_servicebus_subscription.name (validate.SubscriptionName): starts
// alphanumeric, ends alphanumeric or underscore, only `-._` inside, 50 characters.
var azureSubscriptionName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9\-._]{0,48}[a-zA-Z0-9_]$`)

// THE REGRESSION (#2100). This is the exact endpoint the full-bar fixture seeds, and passing it
// through as the name is what killed every azure apply carrying a topic.
func TestServiceBusSubscriptionNameAcceptsTheFullBarEndpoint(t *testing.T) {
	const arn = "arn:aws:sqs:us-east-1:000000000000:jobs"
	got := serviceBusSubscriptionName(arn)
	if !azureSubscriptionName.MatchString(got) {
		t.Errorf("derived name %q is not a valid Azure subscription name — this is the #2100 failure", got)
	}
	if strings.Contains(got, ":") {
		t.Errorf("derived name %q still carries a colon, which is outside Azure's alphabet", got)
	}
}

// Every shape an endpoint realistically takes must land inside the rule.
func TestServiceBusSubscriptionNameIsAlwaysValid(t *testing.T) {
	for _, endpoint := range []string{
		"arn:aws:sqs:us-east-1:000000000000:jobs",
		"https://hook.example.test/very/deep/path?query=1&other=2",
		"https://a-very-long-host-name-that-goes-on.example.test/and/a/long/path/too/beyond/fifty",
		"sqs",
		"UPPER://Mixed.Case/Endpoint",
		"...",      // folds away entirely
		"-leading", // would otherwise start with a hyphen
		"",
	} {
		got := serviceBusSubscriptionName(endpoint)
		if !azureSubscriptionName.MatchString(got) {
			t.Errorf("endpoint %q -> %q, which Azure rejects", endpoint, got)
		}
		if len(got) > 50 {
			t.Errorf("endpoint %q -> %q (%d chars), over Azure's 50", endpoint, got, len(got))
		}
	}
}

// DETERMINISTIC. `name` is ForceNew: a name that changed between runs would destroy and recreate
// the subscription on every apply, silently dropping whatever it had not yet delivered.
func TestServiceBusSubscriptionNameIsStable(t *testing.T) {
	const e = "arn:aws:sqs:us-east-1:000000000000:jobs"
	if a, b := serviceBusSubscriptionName(e), serviceBusSubscriptionName(e); a != b {
		t.Errorf("not deterministic: %q vs %q", a, b)
	}
}

// The hash is taken over the WHOLE endpoint, so two endpoints sharing a long prefix — routine for
// ARNs and URLs, which differ in their tail — still get distinct names. A hash over the truncated
// stem would collide here, and two subscriptions collapsing into one is a silent data-routing bug.
func TestServiceBusSubscriptionNameSurvivesASharedPrefix(t *testing.T) {
	a := serviceBusSubscriptionName("https://a-very-long-host-name-that-goes-on.example.test/path/alpha")
	b := serviceBusSubscriptionName("https://a-very-long-host-name-that-goes-on.example.test/path/beta")
	if a == b {
		t.Errorf("two endpoints differing only in their tail collided on %q", a)
	}
}

// …and distinct endpoints must not collide in general.
func TestServiceBusSubscriptionNamesAreDistinct(t *testing.T) {
	seen := map[string]string{}
	for _, e := range []string{
		"arn:aws:sqs:us-east-1:000000000000:jobs",
		"arn:aws:sqs:us-east-1:000000000000:other",
		"https://hook.example.test/a",
		"https://hook.example.test/b",
	} {
		n := serviceBusSubscriptionName(e)
		if prev, dup := seen[n]; dup {
			t.Errorf("endpoints %q and %q both derived %q", prev, e, n)
		}
		seen[n] = e
	}
}

// End to end through the builder, so the wiring is proven and not just the helper.
func TestBuildServiceBusTopicsEmitsValidSubscriptionNames(t *testing.T) {
	got := buildServiceBusTopics([]types.ProjectTopicConfig{{
		Name: "events",
		Subscriptions: []types.TopicSubscription{
			{Protocol: types.TopicSubscriptionProtocol("sqs"), Endpoint: "arn:aws:sqs:us-east-1:000000000000:jobs"},
		},
	}})
	topic, ok := got["events"].(map[string]interface{})
	if !ok {
		t.Fatalf("no topic emitted: %#v", got)
	}
	subs, ok := topic["subscriptions"].([]map[string]interface{})
	if !ok || len(subs) != 1 {
		t.Fatalf("expected one subscription, got %#v", topic["subscriptions"])
	}
	name, _ := subs[0]["name"].(string)
	if !azureSubscriptionName.MatchString(name) {
		t.Errorf("builder emitted %q, which Azure rejects", name)
	}
}
