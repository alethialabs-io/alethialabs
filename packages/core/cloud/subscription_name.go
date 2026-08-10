// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// endpointNameRules parameterises endpointSubscriptionName by the target provider's naming rules.
// The permitted alphabets genuinely differ per cloud (Azure Service Bus allows `.` `_` inside;
// GCP Pub/Sub allows `~` `+` `%` and demands a leading letter), but the folded output —
// lowercase alphanumerics joined by single hyphens — sits inside every one of them, so the only
// knobs a target needs are its length budget and whether it must start with a letter.
type endpointNameRules struct {
	// maxLen is the total budget for the derived name: readable stem + "-" + 8-char hash.
	maxLen int
	// mustStartWithLetter forces a letter at position 0 (GCP Pub/Sub requires it; Azure Service
	// Bus accepts a leading digit).
	mustStartWithLetter bool
}

// endpointSubscriptionName derives a deterministic, provider-valid subscription name from a
// subscription's endpoint. One shared implementation, parameterised per target — two
// hand-maintained copies of this sanitiser would drift, which is exactly how the Azure fix
// (#2100) shipped without its GCP twin (#2159).
//
// An endpoint is a URL or an ARN, so it routinely carries `:` and `/`, which are outside every
// provider's name alphabet — passed through raw it kills the apply (Azure: #2100; GCP: #2159).
// The name cannot simply be a per-subscription name field, because types.TopicSubscription HAS
// no name: it models a protocol and an endpoint only, and the endpoint already identifies the
// subscription uniquely within its topic.
//
// Shape mirrors ackNamespaceRoleName (alibaba_tenant_identity.go): a readable, truncated stem
// plus a short content hash of the WHOLE endpoint. Both halves are load-bearing.
//
//   - DETERMINISTIC. Subscription names are ForceNew on both azurerm and google providers, so a
//     name that changed between runs would destroy and recreate the subscription on every apply —
//     silently dropping whatever it had not yet delivered.
//   - The hash is over the FULL endpoint, not the truncated stem, so two endpoints sharing a long
//     prefix (routine for ARNs and URLs, which differ in their tail) still get distinct names.
//
// Cloud-parity sweep (#2159): the OTHER two clouds are genuinely immune, not silently omitted.
// AWS emits the endpoint only as the `aws_sns_topic_subscription.endpoint` VALUE — where an ARN
// is the correct payload, and SNS subscriptions have no name argument at all (the sqs-sns module
// builds its subscriptions from `queues_with_topic` with resource-generated queue ARNs; the
// emitted subscriptions list never reaches a name). Alibaba's mns module creates queues and
// topics only — it consumes no subscriptions list, so no resource name is ever derived from an
// endpoint there.
func endpointSubscriptionName(endpoint string, rules endpointNameRules) string {
	sum := sha256.Sum256([]byte(endpoint))
	short := hex.EncodeToString(sum[:])[:8]

	// Fold everything outside lowercase alphanumerics to `-`, so the readable part stays
	// recognisable rather than being dropped. Characters that are legal in SOME targets (`.`,
	// `_`, `~`) are folded too: they add no signal here, and folding them keeps the output valid
	// for every target at once.
	stem := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		default:
			return '-'
		}
	}, endpoint)

	// Collapse runs and trim, so `arn:aws:sqs:` does not become `arn-aws-sqs---`.
	for strings.Contains(stem, "--") {
		stem = strings.ReplaceAll(stem, "--", "-")
	}
	stem = strings.Trim(stem, "-")

	// Budget: maxLen total = stem + "-" + 8.
	maxStem := rules.maxLen - 1 - len(short)
	if len(stem) > maxStem {
		stem = strings.Trim(stem[:maxStem], "-")
	}
	// An endpoint made entirely of punctuation folds away to nothing, and a name must START with
	// an alphanumeric everywhere — so fall back to a fixed prefix rather than emitting a leading
	// `-`. "sub" also satisfies the stricter start-with-a-letter targets.
	if stem == "" {
		stem = "sub"
	}
	if rules.mustStartWithLetter && (stem[0] < 'a' || stem[0] > 'z') {
		stem = "sub-" + stem
		if len(stem) > maxStem {
			stem = strings.Trim(stem[:maxStem], "-")
		}
	}
	return stem + "-" + short
}

// serviceBusSubscriptionName derives a deterministic, Azure-VALID subscription name from a
// subscription's endpoint (#2100). A subscription name must match azurerm's
// `^[a-zA-Z0-9][a-zA-Z0-9-._]{0,48}[a-zA-Z0-9_]$` — alphanumeric at both ends, only `-._`
// inside, 50 characters. (Azure prints its whole validation message, whose 50-character clause
// reads like a length problem. It is not — it is the alphabet.) Budget: 50 total = 41-char stem
// + `-` + 8-char hash.
func serviceBusSubscriptionName(endpoint string) string {
	return endpointSubscriptionName(endpoint, endpointNameRules{maxLen: 50})
}

// pubSubSubscriptionName derives a deterministic, GCP-VALID Pub/Sub subscription name from a
// subscription's endpoint (#2159) — the GCP twin of serviceBusSubscriptionName, which landed
// without it. A Pub/Sub subscription name must start with a letter and contain only letters,
// digits, `-`, `_`, `.`, `~`, `+`, `%`, within 255 characters — an ARN's `:` is outside that
// alphabet, and the full-bar fixture's `arn:aws:sqs:…:jobs` endpoint 400'd every gcp apply
// carrying a topic.
//
// The pubsub module prepends `${var.project_name}-${var.environment}-` to this name
// (infra/templates/project/gcp/modules/pubsub/main.tf), so the budget here is 128 — a readable
// 119-char stem + `-` + 8-char hash — leaving over half of GCP's 255-character cap for the
// prefix.
func pubSubSubscriptionName(endpoint string) string {
	return endpointSubscriptionName(endpoint, endpointNameRules{maxLen: 128, mustStartWithLetter: true})
}
