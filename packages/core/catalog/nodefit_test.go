// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestGKEAllocatableCPUMatchesTheOneNodeThisRepoHasMEASURED is the anchor for everything else in
// this file. Every other assertion here is arithmetic; this one is the single point where the
// arithmetic touches reality.
//
// e2e nightly run 35499891484 printed `allocatable cpu: 940m` on BOTH of its `e2-medium` nodes. If
// the formula stops reproducing that number, the formula is wrong — not the measurement.
func TestGKEAllocatableCPUMatchesTheOneNodeThisRepoHasMEASURED(t *testing.T) {
	const measured = 940
	got := gkeAllocatableCPUMilli(2, true) // e2-medium: 2 vCPU, shared-core
	if got != measured {
		t.Fatalf("computed %dm allocatable for an e2-medium, but run 35499891484 measured %dm on the real node — the reservation model no longer matches the cloud", got, measured)
	}
}

// TestGKEAllocatableCPUFollowsThePublishedTiers walks the reservation formula GKE documents:
// 6% of the first core, 1% of the next core (up to 2), 0.5% of the next 2 (up to 4), 0.25% above 4
// — and a flat 1060m on shared-core E2.
//
// The cases are chosen so that EACH tier is the only thing separating two of them: 1 vs 2 vCPU
// isolates the 1% tier, 2 vs 4 isolates the 0.5% tier, 4 vs 12 isolates the 0.25% tier. A single
// case at 12 vCPU would pass with any two of the three tiers mis-weighted.
func TestGKEAllocatableCPUFollowsThePublishedTiers(t *testing.T) {
	for _, tc := range []struct {
		name       string
		vcpu       float64
		sharedCore bool
		want       int
	}{
		{"1 vCPU dedicated: 6% of one core", 1, false, 1000 - 60},
		{"2 vCPU dedicated: + 1% of the second", 2, false, 2000 - 70},
		{"4 vCPU dedicated: + 0.5% of cores 3 and 4", 4, false, 4000 - 80},
		{"12 vCPU dedicated: + 0.25% of the other 8", 12, false, 12000 - 100},
		{"shared-core pays the flat reservation instead", 2, true, 2000 - 1060},
		{"a shape smaller than the flat reservation has nothing left", 1, true, 0},
		{"zero vCPU is not a node", 0, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := gkeAllocatableCPUMilli(tc.vcpu, tc.sharedCore); got != tc.want {
				t.Errorf("gkeAllocatableCPUMilli(%g, %v) = %d, want %d", tc.vcpu, tc.sharedCore, got, tc.want)
			}
		})
	}
}

// TestSharedCoreClassificationIsARuleNotACatalogSnapshot pins the classifier against machine types
// that are NOT in the catalog, deliberately.
//
// A test that only exercised the catalog's current members would still pass if the classifier were
// rewritten as a hardcoded list of exactly those members — and would then misclassify the next type
// somebody adds. The off-catalog cases are what distinguish a rule from a snapshot.
func TestSharedCoreClassificationIsARuleNotACatalogSnapshot(t *testing.T) {
	for _, in := range []string{"e2-micro", "e2-small", "e2-medium", "f1-micro", "g1-small", "E2-MEDIUM", " e2-small "} {
		if !isGCPSharedCore(in) {
			t.Errorf("%q is a shared-core type GCP documents, but the classifier says otherwise — it would be credited ~990m of CPU it does not have", in)
		}
	}
	for _, in := range []string{"e2-standard-2", "e2-standard-4", "n1-standard-1", "n2-standard-2", "a2-highgpu-1g", "e2-mediumish", ""} {
		if isGCPSharedCore(in) {
			t.Errorf("%q is not shared-core, but the classifier says it is — it would be docked 1060m and refused on arithmetic that does not apply to it", in)
		}
	}
}

// TestControlPlaneNodeFitRefusesTheSHAPETHATWASMEASURED is the regression this whole file exists
// for. `e2-medium` is not a hypothetical too-small shape: it is the shape that ran, and failed, in
// run 35499891484 — and it was the product's DEFAULT GCP machine type when that happened.
func TestControlPlaneNodeFitRefusesTheSHAPETHATWASMEASURED(t *testing.T) {
	fit := MustLoad().ControlPlaneNodeFit("gcp", "e2-medium")

	if fit.Verdict != FitTooSmall {
		t.Fatalf("e2-medium got %s, want %s — this is the exact shape run 35499891484 measured as unable to schedule argocd-repo-server OR GKE's own calico-typha", fit.Verdict, FitTooSmall)
	}
	if fit.AllocatableCPUMilli != 940 {
		t.Errorf("AllocatableCPUMilli = %d, want the measured 940", fit.AllocatableCPUMilli)
	}
	if fit.Suggestion == "" {
		t.Error("the refusal names no way out — a user told only that their shape is wrong has been given half an answer")
	}
	if fit.Suggestion == "e2-medium" {
		t.Error("the suggestion is the refused shape itself")
	}
	// The suggestion must itself pass. Nothing else in the file enforces that the way out works,
	// and a suggestion that is also refused is worse than none.
	if s := MustLoad().ControlPlaneNodeFit("gcp", fit.Suggestion); s.Verdict != FitOK {
		t.Errorf("the suggested %q is itself %s — the refusal sends the user to another refusal", fit.Suggestion, s.Verdict)
	}
	// The one non-obvious fact a reader needs, stated where they will read it.
	if !strings.Contains(fit.Detail, "shared-core") {
		t.Errorf("the detail does not mention shared-core, so it does not explain why a \"2 vCPU\" machine reports 940m: %q", fit.Detail)
	}
}

// TestControlPlaneNodeFitIsUnknownRatherThanRefusingWhatItCannotMODEL pins the fail-open half.
//
// This runs on the live provisioning path. Every branch here is a case where the honest answer is
// "no model", and in every one of them a refusal would be the product blocking a deploy on no
// evidence at all.
func TestControlPlaneNodeFitIsUnknownRatherThanRefusingWhatItCannotMODEL(t *testing.T) {
	c := MustLoad()
	for _, tc := range []struct {
		name               string
		provider, instance string
	}{
		{"another cloud, whose DaemonSet pile is different and unmeasured", "aws", "t3.medium"},
		{"a cloud with no compute inventory at all", "hetzner", "cax11"},
		{"a machine type the catalog does not carry", "gcp", "e2-nonesuch-9"},
		{"no machine type pinned — the template's own default applies", "gcp", ""},
		{"an unknown provider entirely", "nimbus", "big-1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fit := c.ControlPlaneNodeFit(tc.provider, tc.instance)
			if fit.Verdict != FitUnknown {
				t.Errorf("got %s, want %s — refusing here blocks a deploy on no evidence", fit.Verdict, FitUnknown)
			}
			if fit.Detail == "" {
				t.Error("Detail is empty; a check that says nothing cannot be audited from a log")
			}
			if fit.Suggestion != "" {
				t.Errorf("Suggestion is %q on an UNKNOWN verdict — nothing was refused, so there is nothing to suggest", fit.Suggestion)
			}
		})
	}
}

// TestControlPlaneNodeFitAlwaysExplainsItself. Detail is non-empty on EVERY verdict, including OK.
// The passing line is the one a reader needs six weeks later when something else fails and they ask
// what this gate actually checked.
func TestControlPlaneNodeFitAlwaysExplainsItself(t *testing.T) {
	c := MustLoad()
	for provider, cp := range c.Compute {
		for _, in := range cp.Instances {
			fit := c.ControlPlaneNodeFit(provider, in.Value)
			if fit.Detail == "" {
				t.Errorf("%s/%s: %s verdict with an empty Detail", provider, in.Value, fit.Verdict)
			}
			if fit.Verdict == FitOK && fit.Suggestion != "" {
				t.Errorf("%s/%s: passed, but still suggests %q", provider, in.Value, fit.Suggestion)
			}
		}
	}
}

// ── The two guards over the catalog's own data ──
//
// Both range over what the catalog CONTAINS rather than over a list written here, so a machine type
// added tomorrow is checked without anybody remembering this file exists. That is the whole point:
// the defect being fixed is that the product SHIPPED a default nobody had checked.

// TestNoProviderDefaultsToAShapeThatCannotHostTheControlPlane.
//
// `default_instance` is what a user gets when they change nothing, and on gcp it was `e2-medium`
// until this change — the shape measured unable to run either ArgoCD's repo-server or GKE's own
// network-policy control plane. A broken default is the worst kind of defect here because it is the
// path of least resistance.
func TestNoProviderDefaultsToAShapeThatCannotHostTheControlPlane(t *testing.T) {
	c := MustLoad()
	for provider, cp := range c.Compute {
		fit := c.ControlPlaneNodeFit(provider, cp.DefaultInstance)
		if fit.Verdict == FitTooSmall {
			t.Errorf("%s defaults to %q:\n  %s\n  pick %q instead", provider, cp.DefaultInstance, fit.Detail, fit.Suggestion)
		}
	}
}

// TestCrossCloudConversionNeverLandsOnAShapeThatCannotHostTheControlPlane.
//
// `live.instanceTypeMap` is what "convert this project to another cloud" uses. Before this change
// three entries pointed at `e2-medium` (aws `t3.medium`, hetzner `cax11` and `cx23`), so converting
// a perfectly healthy small project onto GCP produced a cluster whose GitOps and NetworkPolicy both
// silently did not work. The capability match was right and the outcome was broken, which is
// exactly the kind of mapping a nearest-vCPU heuristic will keep proposing unless something checks.
func TestCrossCloudConversionNeverLandsOnAShapeThatCannotHostTheControlPlane(t *testing.T) {
	c := MustLoad()
	// Read straight out of the embedded document: `live` is the console-facing half of catalog.json
	// and the Go Catalog struct does not model it. Adding a production accessor purely so a test can
	// reach it would put an unused method on the package.
	var doc struct {
		Live struct {
			InstanceTypeMap map[string]map[string]map[string]string `json:"instanceTypeMap"`
		} `json:"live"`
	}
	if err := json.Unmarshal(catalogJSON, &doc); err != nil {
		t.Fatalf("catalog.json does not parse: %v", err)
	}
	live := doc.Live.InstanceTypeMap
	if len(live) == 0 {
		t.Fatal("catalog.json has no live.instanceTypeMap — this guard has lost its subject and must be repointed, not deleted")
	}
	checked := 0
	for source, targets := range live {
		for target, mapping := range targets {
			for from, to := range mapping {
				checked++
				if fit := c.ControlPlaneNodeFit(target, to); fit.Verdict == FitTooSmall {
					t.Errorf("converting %s/%s to %s lands on %q:\n  %s\n  map it to %q instead", source, from, target, to, fit.Detail, fit.Suggestion)
				}
			}
		}
	}
	// An empty walk is indistinguishable from a clean one, and this map is nested three deep —
	// one wrong key name would make the loop body never run and the test green forever.
	if checked == 0 {
		t.Fatal("walked 0 conversion entries: the map was read but nothing was checked")
	}
}

// TestNodeFitOnInventoriesTheSHIPPEDCatalogDoesNotContain.
//
// Every case here is reachable through `ControlPlaneNodeFit` but not through the catalog as it
// stands today, so a table driven off the shipped document cannot reach them. They are not
// hypothetical: each one is a state the next machine type somebody adds can put the function into,
// and each has a different right answer.
//
// The Catalog struct is built by hand rather than loaded, which is the only way to ask these
// questions without writing a fake shape into the real inventory.
func TestNodeFitOnInventoriesTheSHIPPEDCatalogDoesNotContain(t *testing.T) {
	t.Run("a shape smaller than GKE's own reservation has no computable allocatable", func(t *testing.T) {
		// e2-micro is one shared core. GKE's flat 1060m reservation exceeds the whole machine, so
		// there is no number to compare and the honest verdict is UNKNOWN — not TOO_SMALL, which
		// would be a claim derived from an allocatable figure that does not exist.
		c := &Catalog{Compute: map[string]ComputeProvider{"gcp": {Instances: []Instance{
			{Value: "e2-micro", VCPU: 1, MemoryGB: 1, Family: "general"},
		}}}}
		fit := c.ControlPlaneNodeFit("gcp", "e2-micro")
		if fit.Verdict != FitUnknown {
			t.Errorf("got %s, want %s", fit.Verdict, FitUnknown)
		}
		if !strings.Contains(fit.Detail, "no computable allocatable") {
			t.Errorf("the detail does not say why there is no answer: %q", fit.Detail)
		}
	})

	t.Run("a refusal with nowhere to send the user names no suggestion", func(t *testing.T) {
		// An inventory whose ONLY shape is too small. A suggestion is the one part of the refusal
		// that can be absent, and inventing one — or naming the refused shape back — would be worse
		// than saying nothing.
		c := &Catalog{Compute: map[string]ComputeProvider{"gcp": {Instances: []Instance{
			{Value: "n1-standard-1", VCPU: 1, MemoryGB: 3.75, Family: "general"},
		}}}}
		fit := c.ControlPlaneNodeFit("gcp", "n1-standard-1")
		if fit.Verdict != FitTooSmall {
			t.Fatalf("got %s, want %s", fit.Verdict, FitTooSmall)
		}
		if fit.Suggestion != "" {
			t.Errorf("suggested %q out of an inventory in which nothing fits", fit.Suggestion)
		}
	})

	t.Run("a family with no fitting member falls back to the smallest that does", func(t *testing.T) {
		// The family preference is a preference, not a filter. A GPU shape too small to host the
		// control plane must still be told about a shape that can, even though the answer changes
		// family — an empty suggestion here would be the refusal going quiet on a user who has one
		// obvious way forward.
		c := &Catalog{Compute: map[string]ComputeProvider{"gcp": {Instances: []Instance{
			{Value: "tiny-gpu-1", VCPU: 1, MemoryGB: 8, Family: "gpu"},
			{Value: "e2-standard-2", VCPU: 2, MemoryGB: 8, Family: "general"},
			{Value: "e2-standard-4", VCPU: 4, MemoryGB: 16, Family: "general"},
		}}}}
		fit := c.ControlPlaneNodeFit("gcp", "tiny-gpu-1")
		if fit.Verdict != FitTooSmall {
			t.Fatalf("got %s, want %s", fit.Verdict, FitTooSmall)
		}
		if fit.Suggestion != "e2-standard-2" {
			t.Errorf("suggested %q, want the smallest shape that fits regardless of family", fit.Suggestion)
		}
	})

	t.Run("a provider with no compute inventory is UNKNOWN, not refused", func(t *testing.T) {
		c := &Catalog{Compute: map[string]ComputeProvider{}}
		fit := c.ControlPlaneNodeFit("gcp", "e2-medium")
		if fit.Verdict != FitUnknown {
			t.Errorf("got %s, want %s — an empty inventory is no evidence about a shape", fit.Verdict, FitUnknown)
		}
	})
}
