// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the max-config surface — NO build tag, NO cloud, NO tofu.
//
// This is the "know exactly what's going on" tier: it runs the real cloud.ProviderTfvars over the
// typed max-config ProjectConfig and proves, per kind, that the tfvars the template needs are
// actually emitted — and, for the nine optional kinds, that DROPPING the kind makes its signal go
// away (so the assertion can't pass vacuously). The maintainer-gated nightly then proves each kind's
// resource genuinely lands on real infra; this tier catches a broken wiring for free, before any
// provisioning spend.
package e2e

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// theElevenKinds is the canonical supported-kind set (apps/console/lib/cloud-providers/
// unsupported-kinds.ts enumerates it in its doc comment; the canvas NodeKind union is the runtime
// SSOT). The table must cover EXACTLY these — no dup, no drift, no kind added to the product but not
// the proof surface.
var theElevenKinds = []string{
	"cluster", "network", "database", "cache", "queue", "topic",
	"nosql", "dns", "secrets", "bucket", "registry",
}

// TestMaxConfigCoversAllElevenKinds guards the surface itself: exactly 11 distinct kinds, exactly
// the canonical set.
func TestMaxConfigCoversAllElevenKinds(t *testing.T) {
	if len(MaxConfigKinds) != 11 {
		t.Fatalf("MaxConfigKinds has %d entries, want 11 — the max-config surface drifted from the kind set", len(MaxConfigKinds))
	}
	got := map[string]int{}
	for _, k := range MaxConfigKinds {
		got[k.Kind]++
	}
	for kind, n := range got {
		if n > 1 {
			t.Errorf("kind %q appears %d times in MaxConfigKinds (duplicate)", kind, n)
		}
	}
	for _, want := range theElevenKinds {
		if got[want] == 0 {
			t.Errorf("kind %q is missing from MaxConfigKinds", want)
		}
	}
	for kind := range got {
		if !containsStr(theElevenKinds, kind) {
			t.Errorf("kind %q is in MaxConfigKinds but not the canonical eleven — add it to unsupported-kinds.ts reasoning or fix the table", kind)
		}
	}
}

// TestMaxConfigAWSEmitsEveryKind is the POSITIVE proof: with all 11 kinds populated, AWS
// ProviderTfvars emits a meaningful signal for each.
func TestMaxConfigAWSEmitsEveryKind(t *testing.T) {
	tfvars := awsMaxConfigTfvars(t, "") // no skip — full surface

	for _, k := range MaxConfigKinds {
		for _, sig := range k.AWSSignals {
			v, ok := tfvars[sig]
			if !ok {
				t.Errorf("kind %q: AWS tfvars missing signal %q — the kind is not wired to the template", k.Kind, sig)
				continue
			}
			if !meaningful(v) {
				t.Errorf("kind %q: AWS tfvar %q is present but not meaningful (%#v) — the kind did not populate", k.Kind, sig, v)
			}
		}
	}
}

// TestMaxConfigAWSPerKindNegative is the LOUD negative: for each of the nine optional kinds, drop
// ONLY that kind and prove its (kind-exclusive) signal goes empty — so the positive proof above has
// teeth and can't be passing on an always-present default. Foundational kinds (network/cluster) are
// asserted positively only; a max-config without them is nonsensical, and their teeth come from the
// nine here.
func TestMaxConfigAWSPerKindNegative(t *testing.T) {
	for _, k := range MaxConfigKinds {
		if k.Foundational {
			continue
		}
		t.Run(k.Kind, func(t *testing.T) {
			tfvars := awsMaxConfigTfvars(t, k.Kind) // every kind EXCEPT this one
			for _, sig := range k.AWSSignals {
				if v, ok := tfvars[sig]; ok && meaningful(v) {
					t.Errorf("dropping kind %q left signal %q still meaningful (%#v) — the signal is not kind-exclusive, so the positive proof is vacuous", k.Kind, sig, v)
				}
			}
		})
	}
}

// TestMaxConfigGCPEmitsEveryKind is the POSITIVE proof for GCP: with all 11 kinds populated, GCP
// ProviderTfvars emits a meaningful signal for each. The shape-bearing kinds (cluster/database/cache)
// use GCP-valid literals via the provider-aware Apply, so this also guards that a real GCP apply
// wouldn't be fed an AWS instance type / tier / engine version.
func TestMaxConfigGCPEmitsEveryKind(t *testing.T) {
	tfvars := gcpMaxConfigTfvars(t, "") // no skip — full surface

	for _, k := range MaxConfigKinds {
		for _, sig := range k.GCPSignals {
			v, ok := tfvars[sig]
			if !ok {
				t.Errorf("kind %q: GCP tfvars missing signal %q — the kind is not wired to the template", k.Kind, sig)
				continue
			}
			if !meaningful(v) {
				t.Errorf("kind %q: GCP tfvar %q is present but not meaningful (%#v) — the kind did not populate", k.Kind, sig, v)
			}
		}
	}
}

// TestMaxConfigGCPPerKindNegative is the LOUD negative for GCP. Seven of the nine optional kinds have
// kind-EXCLUSIVE GCP signals (create_*), so the generic drop-and-check works. Queue and topic SHARE
// create_pubsub + pubsub_topics (both fold into the same map), so their discriminator is the
// pubsub_topics MAP KEY — dropping the queue removes "jobs"; dropping the topic removes "events".
func TestMaxConfigGCPPerKindNegative(t *testing.T) {
	for _, k := range MaxConfigKinds {
		if k.Foundational {
			continue
		}
		t.Run(k.Kind, func(t *testing.T) {
			tfvars := gcpMaxConfigTfvars(t, k.Kind) // every kind EXCEPT this one
			switch k.Kind {
			case "queue":
				if pubsubTopicsHasKey(tfvars, "jobs") {
					t.Errorf("dropping kind %q left pubsub_topics[\"jobs\"] present — the queue is not isolable", k.Kind)
				}
			case "topic":
				if pubsubTopicsHasKey(tfvars, "events") {
					t.Errorf("dropping kind %q left pubsub_topics[\"events\"] present — the topic is not isolable", k.Kind)
				}
			default:
				for _, sig := range k.GCPSignals {
					if v, ok := tfvars[sig]; ok && meaningful(v) {
						t.Errorf("dropping kind %q left signal %q still meaningful (%#v) — the signal is not kind-exclusive, so the positive proof is vacuous", k.Kind, sig, v)
					}
				}
			}
		})
	}
}

// pubsubTopicsHasKey reports whether the emitted pubsub_topics map carries the given topic/queue name.
func pubsubTopicsHasKey(tfvars map[string]any, key string) bool {
	m, ok := tfvars["pubsub_topics"].(map[string]interface{})
	if !ok {
		return false
	}
	_, present := m[key]
	return present
}

// TestMaxConfigAzureEmitsEveryKind is the POSITIVE proof for Azure: with all 11 kinds populated, Azure
// ProviderTfvars emits a meaningful signal for each. The shape-bearing kinds (cluster/database/cache)
// use Azure-valid literals via the provider-aware Apply (Standard_D2s_v3 / B_Standard_B1ms / a Managed-
// Redis SKU), so this also guards that a real AKS / PostgreSQL-Flexible / Managed-Redis apply wouldn't
// be fed an AWS instance type / tier / engine version.
func TestMaxConfigAzureEmitsEveryKind(t *testing.T) {
	tfvars := azureMaxConfigTfvars(t, "") // no skip — full surface

	for _, k := range MaxConfigKinds {
		for _, sig := range k.AzureSignals {
			v, ok := tfvars[sig]
			if !ok {
				t.Errorf("kind %q: Azure tfvars missing signal %q — the kind is not wired to the template", k.Kind, sig)
				continue
			}
			if !meaningful(v) {
				t.Errorf("kind %q: Azure tfvar %q is present but not meaningful (%#v) — the kind did not populate", k.Kind, sig, v)
			}
		}
	}
}

// TestMaxConfigAzurePerKindNegative is the LOUD negative for Azure — and, unlike GCP, a PLAIN generic
// drop-and-check for all nine optional kinds. Azure emits DISTINCT service_bus_queues and
// service_bus_topics maps (queue and topic share only the create_service_bus bool, which is NOT a
// signal here), and every other optional kind's signal is a kind-exclusive create_* bool / build*ed
// map that empties when the kind is dropped — so no pubsub_topics-style map-key discriminator is needed.
func TestMaxConfigAzurePerKindNegative(t *testing.T) {
	for _, k := range MaxConfigKinds {
		if k.Foundational {
			continue
		}
		t.Run(k.Kind, func(t *testing.T) {
			tfvars := azureMaxConfigTfvars(t, k.Kind) // every kind EXCEPT this one
			for _, sig := range k.AzureSignals {
				if v, ok := tfvars[sig]; ok && meaningful(v) {
					t.Errorf("dropping kind %q left signal %q still meaningful (%#v) — the signal is not kind-exclusive, so the positive proof is vacuous", k.Kind, sig, v)
				}
			}
		})
	}
}

// TestMaxConfigSnapshotFailsClosed proves MaxConfigSnapshot injects all 11 kind blocks onto a base
// snapshot. (The incomplete-surface guard is covered by Populated on the typed struct — every kind's
// Apply sets its field, so a good build always populates; this asserts the merge reaches the map.)
func TestMaxConfigSnapshotInjectsEveryKind(t *testing.T) {
	base := map[string]any{"id": "e2e-x", "project_name": "maxcfg", "provider": "aws"}
	if err := MaxConfigSnapshot(base, "aws"); err != nil {
		t.Fatalf("MaxConfigSnapshot: %v", err)
	}
	for _, key := range maxConfigSnapshotKeys {
		if _, ok := base[key]; !ok {
			t.Errorf("MaxConfigSnapshot did not inject snapshot key %q", key)
		}
	}
	// The base identity fields must be untouched.
	if base["project_name"] != "maxcfg" {
		t.Errorf("MaxConfigSnapshot clobbered base identity field project_name = %v", base["project_name"])
	}
}

// awsMaxConfigTfvars builds the max-config ProjectConfig (optionally skipping one kind) and returns
// the AWS tfvars. Skipping is how the negative test isolates a single kind's contribution.
func awsMaxConfigTfvars(t *testing.T, skip string) map[string]any {
	t.Helper()
	cfg := maxConfigPCExcept("aws", skip)
	p, err := cloud.NewCloudProvider("aws")
	if err != nil {
		t.Fatalf("NewCloudProvider(aws): %v", err)
	}
	return p.ProviderTfvars(cfg)
}

// gcpMaxConfigTfvars is the GCP twin of awsMaxConfigTfvars.
func gcpMaxConfigTfvars(t *testing.T, skip string) map[string]any {
	t.Helper()
	cfg := maxConfigPCExcept("gcp", skip)
	p, err := cloud.NewCloudProvider("gcp")
	if err != nil {
		t.Fatalf("NewCloudProvider(gcp): %v", err)
	}
	return p.ProviderTfvars(cfg)
}

// azureMaxConfigTfvars is the Azure twin of awsMaxConfigTfvars.
func azureMaxConfigTfvars(t *testing.T, skip string) map[string]any {
	t.Helper()
	cfg := maxConfigPCExcept("azure", skip)
	p, err := cloud.NewCloudProvider("azure")
	if err != nil {
		t.Fatalf("NewCloudProvider(azure): %v", err)
	}
	return p.ProviderTfvars(cfg)
}

// maxConfigPCExcept applies every kind except `skip` (empty = all), leaving the skipped kind's field
// at its zero value.
func maxConfigPCExcept(provider, skip string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: types.CloudProvider(provider)}
	for _, k := range MaxConfigKinds {
		if k.Kind == skip {
			continue
		}
		k.Apply(pc, provider)
	}
	return pc
}

func containsStr(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
