// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// GCP's rule for a Pub/Sub subscription resource id: starts with a letter, then letters, digits,
// `-`, `_`, `.`, `~`, `+`, `%`, up to 255 characters. The pubsub module prepends
// `${project_name}-${environment}-`, so the derived name is budgeted to 128 to leave room.
var gcpSubscriptionName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9\-_.~+%]{2,254}$`)

// THE REGRESSION (#2159). This is the exact endpoint the full-bar fixture seeds, and passing it
// through as the name is what 400'd every gcp apply carrying a topic
// (`Invalid resource name given (name=projects/…/subscriptions/…-arn:aws:sqs:…:jobs)`).
func TestPubSubSubscriptionNameAcceptsTheFullBarEndpoint(t *testing.T) {
	const arn = "arn:aws:sqs:us-east-1:000000000000:jobs"
	got := pubSubSubscriptionName(arn)
	if !gcpSubscriptionName.MatchString(got) {
		t.Errorf("derived name %q is not a valid Pub/Sub subscription name — this is the #2159 failure", got)
	}
	if strings.Contains(got, ":") {
		t.Errorf("derived name %q still carries a colon, which is outside GCP's alphabet", got)
	}
	// Pin the shape: the readable stem survives the fold, and an 8-char content hash follows it.
	const wantStem = "arn-aws-sqs-us-east-1-000000000000-jobs-"
	if !strings.HasPrefix(got, wantStem) {
		t.Errorf("derived name %q lost its readable stem, want prefix %q", got, wantStem)
	}
	if !regexp.MustCompile(`-[0-9a-f]{8}$`).MatchString(got) {
		t.Errorf("derived name %q does not end in the 8-char content hash", got)
	}
}

// Every shape an endpoint realistically takes must land inside the rule — including a leading
// digit, which Azure accepts but GCP does not.
func TestPubSubSubscriptionNameIsAlwaysValid(t *testing.T) {
	for _, endpoint := range []string{
		"arn:aws:sqs:us-east-1:000000000000:jobs",
		"https://hook.example.test/very/deep/path?query=1&other=2",
		"https://a-very-long-host-name-that-goes-on.example.test/and/a/long/path/too/beyond/fifty",
		"sqs",
		"UPPER://Mixed.Case/Endpoint",
		"000000000000:jobs", // folds to a leading digit, which GCP rejects at position 0
		"...",               // folds away entirely
		"-leading",          // would otherwise start with a hyphen
		"",
	} {
		got := pubSubSubscriptionName(endpoint)
		if !gcpSubscriptionName.MatchString(got) {
			t.Errorf("endpoint %q -> %q, which GCP rejects", endpoint, got)
		}
		if len(got) > 128 {
			t.Errorf("endpoint %q -> %q (%d chars), over the 128 budget", endpoint, got, len(got))
		}
	}
}

// DETERMINISTIC. `google_pubsub_subscription.name` is ForceNew: a name that changed between runs
// would destroy and recreate the subscription on every apply, silently dropping whatever it had
// not yet delivered.
func TestPubSubSubscriptionNameIsStable(t *testing.T) {
	const e = "arn:aws:sqs:us-east-1:000000000000:jobs"
	if a, b := pubSubSubscriptionName(e), pubSubSubscriptionName(e); a != b {
		t.Errorf("not deterministic: %q vs %q", a, b)
	}
}

// The hash is taken over the WHOLE endpoint, so two endpoints sharing a long prefix — routine for
// ARNs and URLs, which differ in their tail — still get distinct names.
func TestPubSubSubscriptionNameSurvivesASharedPrefix(t *testing.T) {
	long := strings.Repeat("very-long-shared-prefix/", 8)
	a := pubSubSubscriptionName("https://host.example.test/" + long + "alpha")
	b := pubSubSubscriptionName("https://host.example.test/" + long + "beta")
	if a == b {
		t.Errorf("two endpoints differing only in their tail collided on %q", a)
	}
}

// The Azure and GCP names come from ONE shared implementation (endpointSubscriptionName) — this
// pins that the refactor did not change the Azure output, because
// `azurerm_servicebus_subscription.name` is ForceNew and a changed name would destroy and
// recreate every existing subscription.
func TestSharedHelperPreservesTheAzureName(t *testing.T) {
	const e = "arn:aws:sqs:us-east-1:000000000000:jobs"
	if got := serviceBusSubscriptionName(e); !strings.HasPrefix(got, "arn-aws-sqs-us-east-1-000000000000-jobs-") || len(got) > 50 {
		t.Errorf("Azure name changed shape under the shared helper: %q", got)
	}
}

// End to end through the builder, so the wiring is proven and not just the helper.
func TestBuildPubSubTopicsEmitsValidSubscriptionNames(t *testing.T) {
	got := buildPubSubTopics([]types.ProjectTopicConfig{{
		Name: "events",
		Subscriptions: []types.TopicSubscription{
			{Protocol: types.TopicSubscriptionProtocol("sqs"), Endpoint: "arn:aws:sqs:us-east-1:000000000000:jobs"},
		},
	}}, nil)
	topic, ok := got["events"].(map[string]interface{})
	if !ok {
		t.Fatalf("no topic emitted: %#v", got)
	}
	subs, ok := topic["subscriptions"].([]map[string]interface{})
	if !ok || len(subs) != 1 {
		t.Fatalf("expected one subscription, got %#v", topic["subscriptions"])
	}
	name, _ := subs[0]["name"].(string)
	if !gcpSubscriptionName.MatchString(name) {
		t.Errorf("builder emitted %q, which GCP rejects", name)
	}
}
