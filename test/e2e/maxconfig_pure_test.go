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
	"sort"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/compat"
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
		if !containsString(theElevenKinds, kind) {
			t.Errorf("kind %q is in MaxConfigKinds but not the canonical eleven — add it to unsupported-kinds.ts reasoning or fix the table", kind)
		}
	}
}

// TestMaxConfigEmitsEveryTofuCarriedKind is the POSITIVE proof, on EVERY cloud the harness knows:
// with the cloud's full offered surface populated, its real ProviderTfvars emits a meaningful signal
// for each tofu-carried kind. The shape-bearing kinds (cluster/database/cache) use cloud-VALID
// literals via the provider-aware Apply, so this also guards that a real GKE / Cloud SQL / AKS /
// Talos / ACK apply is never fed an AWS instance type, tier or engine version.
//
// It loops the cloud set rather than repeating itself per cloud, and that is deliberate: the same
// copy-per-cloud shape is how the resource table came to describe three clouds and skip two.
// In-cluster and ceiling cells carry no tfvars by construction (MaxConfigCell.Validate enforces it),
// so they contribute nothing here — their proof is the ArgoCD gate and the documented Why.
func TestMaxConfigEmitsEveryTofuCarriedKind(t *testing.T) {
	for _, provider := range maxConfigClouds() {
		t.Run(provider, func(t *testing.T) {
			tfvars := maxConfigTfvars(t, provider, "") // no skip — the cloud's full offered surface
			for _, k := range MaxConfigKinds {
				cell := maxConfigCell(t, k, provider)
				for _, sig := range cell.Signals {
					v, ok := tfvars[sig]
					if !ok {
						t.Errorf("kind %q: %s tfvars missing signal %q — the kind is not wired to the template", k.Kind, provider, sig)
						continue
					}
					if !meaningful(v) {
						t.Errorf("kind %q: %s tfvar %q is present but not meaningful (%#v) — the kind did not populate", k.Kind, provider, sig, v)
					}
				}
			}
		})
	}
}

// TestMaxConfigPerKindNegative is the LOUD negative, on every cloud: for each optional kind the cloud
// carries in tofu, drop ONLY that kind and prove its (kind-exclusive) signal goes empty — so the
// positive proof has teeth and cannot be passing on an always-present default.
//
// Foundational kinds (network/cluster) are asserted positively only; a max-config without them is
// nonsensical, and their teeth come from the optional kinds here. Two clouds fold queue and topic
// into ONE tfvar and need a map-key discriminator instead:
//
//   - GCP: create_pubsub + pubsub_topics carry both, so the key is pubsub_topics["jobs"|"events"].
//   - Alibaba: create_mns is len(Queues)>0 || len(Topics)>0 — the same shape — but the emitted maps
//     ARE distinct (mns_queues / mns_topics), so the plain check works and create_mns is simply not
//     listed as a signal.
func TestMaxConfigPerKindNegative(t *testing.T) {
	for _, provider := range maxConfigClouds() {
		t.Run(provider, func(t *testing.T) {
			for _, k := range MaxConfigKinds {
				if k.Foundational {
					continue
				}
				cell := maxConfigCell(t, k, provider)
				if cell.Carriage != CarriedByTofu {
					continue // nothing to drop: no tfvar carries an in-cluster chart or a ceiling
				}
				t.Run(k.Kind, func(t *testing.T) {
					tfvars := maxConfigTfvars(t, provider, k.Kind) // every offered kind EXCEPT this one
					if provider == "gcp" && (k.Kind == "queue" || k.Kind == "topic") {
						name := maxConfigQueueName
						if k.Kind == "topic" {
							name = maxConfigTopicName
						}
						if pubsubTopicsHasKey(tfvars, name) {
							t.Errorf("dropping kind %q left pubsub_topics[%q] present — the kind is not isolable", k.Kind, name)
						}
						return
					}
					for _, sig := range cell.Signals {
						if v, ok := tfvars[sig]; ok && meaningful(v) {
							t.Errorf("dropping kind %q left signal %q still meaningful (%#v) — the signal is not kind-exclusive, so the positive proof is vacuous", k.Kind, sig, v)
						}
					}
				})
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

// maxConfigClouds is the cloud set the max-config surface must describe — the harness's OWN provider
// table (t2ProviderTable in t2_providers.go), never a hand-written list. A sixth cloud added there
// reds every test in this file until it has a column and a verdict per kind, which is exactly the
// drift that let hetzner and alibaba sit structurally unassertable for the table's whole life.
func maxConfigClouds() []string {
	names := make([]string, 0, len(t2ProviderTable))
	for name := range t2ProviderTable {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// maxConfigCell fetches the (kind × cloud) verdict, failing the test when the cloud has no column —
// the read-back that makes an unhandled pair loud instead of skipped.
func maxConfigCell(t *testing.T, k MaxConfigKind, provider string) MaxConfigCell {
	t.Helper()
	cell, ok := k.Cell(provider)
	if !ok {
		t.Fatalf("kind %q has no column for cloud %q — add the per-cloud column to MaxConfigKind", k.Kind, provider)
	}
	return cell
}

// maxConfigTfvars builds the max-config ProjectConfig for a cloud (optionally skipping one kind) and
// returns that cloud's REAL ProviderTfvars. Skipping is how the negative test isolates a single
// kind's contribution.
func maxConfigTfvars(t *testing.T, provider, skip string) map[string]any {
	t.Helper()
	cfg := maxConfigPCExcept(provider, skip)
	p, err := cloud.NewCloudProvider(provider)
	if err != nil {
		t.Fatalf("NewCloudProvider(%s): %v", provider, err)
	}
	return p.ProviderTfvars(cfg)
}

// maxConfigPCExcept applies every kind this cloud OFFERS except `skip` (empty = all), leaving the
// skipped kind's field at its zero value. Kinds the cloud does not offer (a documented ceiling or
// deferred debt) are never applied — the same Cell.Offered rule MaxConfigProjectConfig follows, so
// the negative test isolates against the config the product could actually express on that cloud.
func maxConfigPCExcept(provider, skip string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: types.CloudProvider(provider)}
	for _, k := range MaxConfigKinds {
		if k.Kind == skip {
			continue
		}
		cell, ok := k.Cell(provider)
		if !ok || !cell.Offered() {
			continue
		}
		k.Apply(pc, provider)
	}
	return pc
}

// TestMaxConfigClusterVersionTracksMatrix is the drift guard for the one value the harness must
// never invent: the cluster's Kubernetes minor.
//
// It exists because a hardcoded "1.32" survived in maxconfig.go long after every cloud's window
// moved to 1.33-1.35. It was bumped for gcp and azure as each cloud rejected it, but left stale for
// aws, alibaba and hetzner — and nothing caught that, because the only run that injects the harness
// version is the max-config nightly, which is main-gated and had been dying earlier in the pipeline
// for six weeks. The apply then failed fail-closed on COMPAT-001 (#1259) after 31 minutes and a
// 178-resource plan.
//
// So the assertion lives HERE, in the untagged every-PR tier, not in the nightly: the moment
// matrix.json moves ahead of the harness, any PR goes red — for free, before any provisioning
// spend. It iterates the matrix's own cloud set rather than a hand-written list, so a sixth cloud
// is covered the day it is added.
func TestMaxConfigClusterVersionTracksMatrix(t *testing.T) {
	m := compat.MustLoad()
	if len(m.K8sCloud) == 0 {
		t.Fatal("compat matrix has no k8s_cloud entries — the guard would pass vacuously")
	}
	for provider, cloudK8s := range m.K8sCloud {
		t.Run(provider, func(t *testing.T) {
			got := maxConfigPCExcept(provider, "").Cluster.ClusterVersion
			if got == "" {
				t.Fatalf("%s: max-config emitted an empty ClusterVersion", provider)
			}
			if !containsString(cloudK8s.Supported, got) {
				t.Errorf("%s: max-config emits Kubernetes %q, which is NOT in the matrix window %v.\n"+
					"A real apply is guarded fail-closed against this same matrix (COMPAT-001), so this "+
					"would burn a full provisioning run before failing. Align maxconfig.go with "+
					"packages/core/compat/matrix.json.", provider, got, cloudK8s.Supported)
			}
		})
	}
}

// TestMaxConfigDNSFixtureIsProvisionable is the guard for a fixture value that had NEVER once
// worked and looked fine in review.
//
// The `dns` kind shipped with DomainName "example.com". AWS RESERVES that name, so
// aws_route53_zone refused it outright ("InvalidDomainName: example.com is reserved by AWS!") and
// the weekly full bar failed identically on the dns kind every Sunday — invisible, because the
// nightly floor never exercises the kind at all and the auto-filer deduped the full-bar red away
// against the floor's (#1755).
//
// So this asserts the two properties that actually matter, in the free every-PR tier rather than
// in the main-gated nightly, where the feedback loop is a week long:
//
//   - the domain is not one of the names a cloud reserves or an RFC parks, and
//   - the ACM path stays OFF while no zone is delegated to the e2e account (see MaxConfigDomain:
//     aws_acm_certificate_validation BLOCKS until PUBLIC issuance, which a zone we merely created
//     can never satisfy — so leaving it on would swap one guaranteed timeout for another).
//
// The reserved list is spelled out rather than pattern-matched: these are the specific names that
// have burned this fixture or would, and a literal is what fails loudly when someone reaches for
// the familiar placeholder again.
func TestMaxConfigDNSFixtureIsProvisionable(t *testing.T) {
	reserved := []string{
		"example.com", "example.net", "example.org", // RFC 2606 + explicitly reserved by AWS
		"example", "invalid", "localhost", "test", // RFC 2606 / RFC 6761 parked TLDs
	}

	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		t.Run(provider, func(t *testing.T) {
			pc := MaxConfigProjectConfig(provider)

			if pc.DNS.DomainName == "" {
				t.Fatal("the dns kind must set a DomainName — an empty zone name provisions nothing and the kind reports vacuously green")
			}
			for _, bad := range reserved {
				if pc.DNS.DomainName == bad || strings.HasSuffix(pc.DNS.DomainName, "."+bad) {
					t.Errorf("dns fixture domain %q is reserved (%q) — no cloud will create a public zone for it; "+
						"use a name under a domain Alethia actually owns", pc.DNS.DomainName, bad)
				}
			}

			// ACM issuance is unprovable without a delegated zone. If this ever flips back on, it
			// must be because e2e.alethialabs.io was delegated into the e2e account — and then this
			// assertion is the thing that should be deleted deliberately, not silently drifted past.
			if acm, ok := pc.DNS.ProviderConfig["acm_certificate"].(bool); ok && acm {
				t.Error("acm_certificate must stay false until a zone is DELEGATED to the e2e account: " +
					"aws_acm_certificate_validation blocks on PUBLIC issuance, which a zone we merely created cannot satisfy")
			}
		})
	}
}

// TestMaxConfigDomainIsRunScoped pins the run-scoping, because two nightly runs sharing one zone
// name is the failure mode that replaces the one being fixed: a leaked zone from a failed run would
// collide with the next run's, and Route 53 happily creates a SECOND zone with the same name rather
// than erroring — so the collision would be silent.
func TestMaxConfigDomainIsRunScoped(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ENV", "30738253176-1")
	scoped := MaxConfigDomain()
	if !strings.HasPrefix(scoped, "30738253176-1.") {
		t.Errorf("MaxConfigDomain must be scoped by ALETHIA_E2E_ENV, got %q", scoped)
	}
	if !strings.HasSuffix(scoped, ".e2e.alethialabs.io") {
		t.Errorf("MaxConfigDomain must sit under a domain Alethia owns, got %q", scoped)
	}

	// No environment (the pure unit tier) must still yield a usable, deterministic name — otherwise
	// the fixture would emit a bare "." -prefixed label and every assertion above would test nothing.
	t.Setenv("ALETHIA_E2E_ENV", "")
	if bare := MaxConfigDomain(); bare != "e2e.alethialabs.io" {
		t.Errorf("with no ALETHIA_E2E_ENV the domain must fall back to the bare suffix, got %q", bare)
	}
}
