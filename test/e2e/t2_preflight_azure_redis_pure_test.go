// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the azure Managed Redis pre-spend preflight — no cloud, no `az`, no credential.
//
// The axis these vary is WHAT WAS KNOWN AND WHAT THE CLOUD SAID, in both directions. That is the
// axis the bug lived on: run 33108860073 had every credential wired, passed the VM preflight, and
// still burned ~1724s of paid apply because nobody asked whether Managed Redis could be
// allocated. A test that varied the credential would have passed against it.
//
// Every assertion below is written to FAIL if the behaviour it names is reverted — the message
// substrings are the specific words each branch owes the reader, not a generic "not empty".
package e2e

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// azureRPLocationsSample is the shape `az provider show` really answers in: DISPLAY names, with
// spaces and capitals, against region slugs everywhere else in this repo. Getting this wrong
// makes every region miss the list, which turns the gate into a blanket refusal of every azure
// run — so it is the shape the tests are written against.
var azureRPLocationsSample = []string{"West Europe", "North Europe", "Sweden Central", "Germany West Central", "East US"}

func TestNormalizeAzureLocation(t *testing.T) {
	tests := []struct{ in, want string }{
		{"West Europe", "westeurope"},
		{"westeurope", "westeurope"},
		{"  Sweden Central  ", "swedencentral"},
		{"swedencentral", "swedencentral"},
		{"Germany West Central", "germanywestcentral"},
		{"East US 2 EUAP", "eastus2euap"},
		{"", ""},
		{"   ", ""},
	}
	for _, tc := range tests {
		if got := normalizeAzureLocation(tc.in); got != tc.want {
			t.Errorf("normalizeAzureLocation(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	// The pair that matters: a display name and its slug must fold to the SAME value. Asserted as
	// an equality rather than two separate literals, so a normaliser that mangled both identically
	// would still be caught by the table above and a normaliser that mangled one is caught here.
	if normalizeAzureLocation("West Europe") != normalizeAzureLocation("westeurope") {
		t.Error("a display name and its region slug must fold to the same value — otherwise every region misses the offered list and the gate refuses every azure run")
	}
}

func TestAzureLocationOffered(t *testing.T) {
	if !azureLocationOffered(azureRPLocationsSample, "swedencentral") {
		t.Error("swedencentral must match \"Sweden Central\" — the RP answers in display names")
	}
	if azureLocationOffered(azureRPLocationsSample, "uksouth") {
		t.Error("uksouth is not in the sample and must not match")
	}
	// An empty region must not match anything. Folding "" against a list would otherwise be a
	// free PROCEED for a run whose region never resolved.
	if azureLocationOffered(azureRPLocationsSample, "  ") {
		t.Error("a blank region must never be reported as offered")
	}
}

func TestLookupAzureRedisKnownBad(t *testing.T) {
	// THE REGRESSION PAIR. #3078's run asked for exactly this and died mid-apply.
	fact, exact := lookupAzureRedisKnownBad("westeurope", "Balanced_B0")
	if !exact || fact == nil {
		t.Fatalf("westeurope/Balanced_B0 must be an EXACT ledger hit — it is the measured failure this gate exists for; got exact=%v fact=%v", exact, fact)
	}
	if !strings.Contains(fact.Evidence, "33108860073") {
		t.Errorf("the westeurope fact must name the run that measured it; evidence = %q", fact.Evidence)
	}

	// Same region, a sku nobody has tried. NOT an exact hit — the ledger records measurements,
	// not extrapolations — but the region's history must still come back so the caller can warn.
	fact, exact = lookupAzureRedisKnownBad("westeurope", "MemoryOptimized_M10")
	if exact {
		t.Error("MemoryOptimized_M10 has never been tried in westeurope — reporting it as a measured failure would refuse a run on a guess")
	}
	if fact == nil {
		t.Error("the region's measured history must still be returned, so the verdict can carry a warning")
	}

	// A region with no history at all.
	if fact, exact := lookupAzureRedisKnownBad("swedencentral", "Balanced_B0"); exact || fact != nil {
		t.Errorf("swedencentral has no measured failure and must return nothing; got exact=%v fact=%v", exact, fact)
	}

	// Display-name spelling must reach the same fact — a caller that passed "West Europe" must
	// not slip past the ledger.
	if _, exact := lookupAzureRedisKnownBad("West Europe", "Balanced_B0"); !exact {
		t.Error("the ledger must fold region spellings the same way the offered-list check does")
	}
}

// TestEveryKnownBadFactCarriesItsEvidence guards the ledger itself. An entry with no run id is an
// opinion, and an entry with no sku refuses everything in a region on the strength of nothing.
func TestEveryKnownBadFactCarriesItsEvidence(t *testing.T) {
	if len(azureRedisKnownBad) == 0 {
		t.Fatal("the ledger is EMPTY — leg 1 is the only capacity signal that exists, so an empty ledger makes this gate unable to catch #3078 at all")
	}
	for _, f := range azureRedisKnownBad {
		if strings.TrimSpace(f.Region) == "" {
			t.Error("a ledger fact with no region cannot be matched against anything")
		}
		if len(f.SKUs) == 0 {
			t.Errorf("%s: a fact with no sku would have to refuse every sku in the region, which is an extrapolation and not a measurement", f.Region)
		}
		if len(strings.TrimSpace(f.Evidence)) < 40 {
			t.Errorf("%s: evidence %q is too thin to re-check — a fact a reader cannot verify is one nobody will ever remove", f.Region, f.Evidence)
		}
	}
}

func TestDecideAzureManagedRedisCapacity(t *testing.T) {
	tests := []struct {
		name          string
		region, sku   string
		offered       []string
		probeErr      error
		allowKnownBad bool
		verdict       preflightVerdict
		mustSay       []string
		mustNotSay    []string
	}{
		{
			// THE REGRESSION. westeurope + the floor sku, refused for free instead of at ~1724s.
			name:   "the measured westeurope pair is refused before any spend",
			region: "westeurope", sku: "Balanced_B0", offered: azureRPLocationsSample,
			verdict: preflightRefuse,
			mustSay: []string{"Balanced_B0", "westeurope", "33108860073", "swedencentral", azureRedisAllowKnownBadEnv},
		},
		{
			// A probe outage must NOT discard the one fact a paid run bought. The ledger runs
			// first and does not depend on the cloud read.
			name:   "a probe outage does not lose the ledger",
			region: "westeurope", sku: "Balanced_B0", offered: nil, probeErr: errors.New("az: executable file not found"),
			verdict: preflightRefuse,
			mustSay: []string{"33108860073", "MEASURED"},
		},
		{
			// ...and the inverse: a region with no history must NEVER be refused because the
			// probe failed. UNKNOWN is a probe that did not answer, not an answer of "no".
			name:   "a probe error on an unmeasured region is UNKNOWN, never a refusal",
			region: "swedencentral", sku: "Balanced_B0", offered: nil, probeErr: errors.New("az: signal: killed"),
			verdict: preflightUnknown,
			mustSay: []string{"UNVERIFIED", "NOT checked", "signal: killed"},
		},
		{
			// nil is the absence of an answer. Collapsing it into the empty case would red a
			// nightly on a network blip.
			name:   "a NIL location list is the absence of an answer",
			region: "swedencentral", sku: "Balanced_B0", offered: nil,
			verdict: preflightUnknown,
			mustSay: []string{"no list at all", "NOT checked"},
		},
		{
			// ...and an EMPTY list is an answer. The probe's JMESPath yields null (an error, and
			// therefore UNKNOWN) when the type matches nothing, so `[]` can only mean the type
			// matched and is offered nowhere.
			name:   "an EMPTY location list is an ANSWER and refuses",
			region: "swedencentral", sku: "Balanced_B0", offered: []string{},
			verdict: preflightRefuse,
			mustSay: []string{"NO location at all", "refused before any spend"},
		},
		{
			name:   "a region the RP does not offer the type in is refused",
			region: "uksouth", sku: "Balanced_B0", offered: azureRPLocationsSample,
			verdict: preflightRefuse,
			mustSay: []string{"NOT offered in uksouth", "Sweden Central"},
		},
		{
			// The clean path — and it must still say that availability is not capacity, because
			// westeurope satisfied exactly this check and could not allocate.
			name:   "an offered region with no measured failure proceeds, WITH the caveat",
			region: "swedencentral", sku: "Balanced_B0", offered: azureRPLocationsSample,
			verdict: preflightProceed,
			mustSay: []string{"offered in swedencentral", "CAVEAT", "no read-only CAPACITY api", "NOT \"capacity is"},
		},
		{
			// An unmeasured sku in a measured-bad region: WARN, do not refuse. Refusing here
			// would be refusing on an extrapolation, and a guard that blocks good work gets
			// switched off along with its real refusals.
			name:   "an untried sku in a known-bad region warns and does not refuse",
			region: "westeurope", sku: "MemoryOptimized_M10", offered: azureRPLocationsSample,
			verdict:    preflightProceed,
			mustSay:    []string{"WARNING", "westeurope", "Balanced_B0", "has not been tried here"},
			mustNotSay: []string{"refused before any spend"},
		},
		{
			// The escape hatch. A maintainer must be able to re-test a region whose capacity may
			// have come back, without editing the ledger or disabling the gate.
			name:   "the override downgrades a ledger refusal to a loud annotation",
			region: "westeurope", sku: "Balanced_B0", offered: azureRPLocationsSample, allowKnownBad: true,
			verdict: preflightProceed,
			mustSay: []string{"OVERRIDE IN EFFECT", azureRedisAllowKnownBadEnv, "33108860073", "if the apply dies on capacity, this is why"},
		},
		{
			// ...but the override does NOT lift leg 2. "The RP does not offer it here" is not a
			// capacity observation that might have expired.
			name:   "the override does not lift a cloud-answered refusal",
			region: "uksouth", sku: "Balanced_B0", offered: azureRPLocationsSample, allowKnownBad: true,
			verdict: preflightRefuse,
			mustSay: []string{"NOT offered in uksouth"},
		},
		{
			// Nothing to check is not a clean check.
			name:   "an unresolved sku is UNKNOWN, not a pass",
			region: "westeurope", sku: "  ", offered: azureRPLocationsSample,
			verdict: preflightUnknown,
			mustSay: []string{"no Managed Redis sku was resolved", "nothing was checked"},
		},
		{
			// A region that folds to nothing matches no offered location, so the membership test
			// would REFUSE it — a refusal caused by OUR missing input, not by anything the cloud
			// said. This guard must fail toward "we did not check", never toward blocking a run.
			name:   "an unresolved region is UNKNOWN, not a refusal",
			region: "   ", sku: "Balanced_B0", offered: azureRPLocationsSample,
			verdict:    preflightUnknown,
			mustSay:    []string{"no azure region was resolved", "checked against nothing"},
			mustNotSay: []string{"Refused before any spend"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideAzureManagedRedisCapacity("probe", tc.region, tc.sku, tc.offered, tc.probeErr, tc.allowKnownBad)
			if got.Verdict != tc.verdict {
				t.Fatalf("verdict = %s, want %s\ndetail: %s", got.Verdict, tc.verdict, got.Detail)
			}
			if strings.TrimSpace(got.Detail) == "" {
				t.Fatal("Detail is empty — a verdict that says nothing cannot be told apart from a check that never ran")
			}
			if got.Probe != "probe" {
				t.Errorf("Probe = %q — the verdict must name what was actually asked", got.Probe)
			}
			for _, want := range tc.mustSay {
				if !strings.Contains(got.Detail, want) {
					t.Errorf("detail does not mention %q\ngot: %s", want, got.Detail)
				}
			}
			for _, unwanted := range tc.mustNotSay {
				if strings.Contains(got.Detail, unwanted) {
					t.Errorf("detail must NOT contain %q\ngot: %s", unwanted, got.Detail)
				}
			}
		})
	}
}

// TestAzureRedisCaveatIsAppendedNotSubstituted pins the shape of the annotation, not just its
// presence. A caveat written as another switch case REPLACES the finding it was meant to
// qualify — the warning on an untried sku in westeurope must sit ALONGSIDE the availability
// result, not instead of it.
func TestAzureRedisCaveatIsAppendedNotSubstituted(t *testing.T) {
	got := decideAzureManagedRedisCapacity("probe", "westeurope", "MemoryOptimized_M10", azureRPLocationsSample, nil, false)
	if got.Verdict != preflightProceed {
		t.Fatalf("verdict = %s, want PROCEED", got.Verdict)
	}
	// All three sentences must be present at once: what the cloud said, the standing caveat, and
	// the region's history.
	for _, want := range []string{"is offered in westeurope", "CAVEAT", "WARNING"} {
		if !strings.Contains(got.Detail, want) {
			t.Errorf("the annotation replaced the verdict instead of adding to it — %q is missing\ngot: %s", want, got.Detail)
		}
	}
	// Ordering, guarded on both being present so a MISSING piece is reported once, by the loop
	// above, rather than twice with a second message that names the wrong problem.
	if i, j := strings.Index(got.Detail, "is offered in westeurope"), strings.Index(got.Detail, "WARNING"); i >= 0 && j >= 0 && i > j {
		t.Error("the cloud's own finding must come FIRST; the annotations follow it")
	}
}

// TestAzureRedisOutcomeFatality pins the (fatal, msg) contract in both directions. This is the
// branch a passing run can never demonstrate: a gate that is fatal in neither direction is
// indistinguishable from one that always passes.
func TestAzureRedisOutcomeFatality(t *testing.T) {
	refuse := preflightResult{Verdict: preflightRefuse, Probe: "p", Detail: "d"}
	unknown := preflightResult{Verdict: preflightUnknown, Probe: "p", Detail: "d"}
	proceed := preflightResult{Verdict: preflightProceed, Probe: "p", Detail: "d"}

	t.Run("under REQUIRE a refusal is fatal and nothing else is", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
		if fatal, msg := azureRedisPreflightOutcome(refuse, "Balanced_B0", "src"); !fatal {
			t.Errorf("a REFUSE must stop the nightly before any spend; msg = %s", msg)
		}
		if fatal, _ := azureRedisPreflightOutcome(unknown, "Balanced_B0", "src"); fatal {
			t.Error("an UNKNOWN must NEVER red a nightly — one `az` hiccup would take the whole cloud down")
		}
		if fatal, _ := azureRedisPreflightOutcome(proceed, "Balanced_B0", "src"); fatal {
			t.Error("a PROCEED must never be fatal")
		}
	})
	t.Run("off CI a refusal is only a warning", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "")
		if fatal, _ := azureRedisPreflightOutcome(refuse, "Balanced_B0", "src"); fatal {
			t.Error("off CI a refusal warns rather than fails, exactly as every other T2 prerequisite does")
		}
	})

	// The message must carry the verdict, the sku and where the sku came from — a log line that
	// says only "refused" cannot be acted on.
	_, msg := azureRedisPreflightOutcome(refuse, "Balanced_B0", "the template's legacy tier map")
	for _, want := range []string{string(preflightRefuse), "Balanced_B0", "the template's legacy tier map", "probe:"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the log line does not mention %q\ngot: %s", want, msg)
		}
	}
}

func TestAzureCacheSKUFromTfvars(t *testing.T) {
	tests := []struct {
		name       string
		tf         map[string]any
		wantSKU    string
		sourceSays string
	}{
		{
			name:    "an exact sku from the control plane wins",
			tf:      map[string]any{"azure_cache_sku_name": "MemoryOptimized_M10"},
			wantSKU: "MemoryOptimized_M10", sourceSays: "azure_cache_sku_name",
		},
		{
			// THE PATH #3078's RUN TOOK. The control plane emits no exact sku for a max-config
			// azure cache, so the TEMPLATE resolves it — and a guard that stopped at "the emitter
			// said nothing" would report UNKNOWN on the exact run it exists to protect.
			name:    "no exact sku falls through to the template's default tier",
			tf:      map[string]any{},
			wantSKU: "Balanced_B0", sourceSays: "legacy tier map",
		},
		{
			name:    "an explicit legacy tier is mapped",
			tf:      map[string]any{"azure_cache_sku": "Standard"},
			wantSKU: "Balanced_B1", sourceSays: "legacy tier map",
		},
		{
			name:    "Premium maps to the top of the legacy ladder",
			tf:      map[string]any{"azure_cache_sku": "Premium"},
			wantSKU: "Balanced_B3", sourceSays: "legacy tier map",
		},
		{
			// The HCL lookup()'s own default. A tier the map does not carry must resolve the way
			// the template resolves it, not to "".
			name:    "an unmapped legacy tier takes the lookup fallback",
			tf:      map[string]any{"azure_cache_sku": "Enterprise"},
			wantSKU: "Balanced_B0", sourceSays: "fallback",
		},
		{
			// An empty string is not an exact sku. Treating it as one would resolve to "", which
			// the decision reports as "nothing was checked" — an inert gate.
			name:    "a blank exact sku is not an answer",
			tf:      map[string]any{"azure_cache_sku_name": "   "},
			wantSKU: "Balanced_B0", sourceSays: "legacy tier map",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sku, source := azureCacheSKUFromTfvars(tc.tf)
			if sku != tc.wantSKU {
				t.Errorf("sku = %q, want %q", sku, tc.wantSKU)
			}
			if !strings.Contains(source, tc.sourceSays) {
				t.Errorf("source = %q, want it to mention %q — a sku with no provenance cannot be re-derived by a reader", source, tc.sourceSays)
			}
		})
	}
}

// TestAzureManagedRedisSKUFromTheRealMaxConfigSurface is the anti-inertness test, and the most
// important one in this file.
//
// It builds the ACTUAL max-config azure snapshot — the same MaxConfigSnapshot the nightly
// provisions from — and asserts the guard resolves the sku run 33108860073 requested. If the
// resolution chain ever stops reaching a value (an emitter rename, a template default change),
// this gate degrades to a silent UNKNOWN on the one run it was built for, and only an assertion
// on the VALUE catches that. Asserting "no error" would pass on "".
func TestAzureManagedRedisSKUFromTheRealMaxConfigSurface(t *testing.T) {
	snapshot := map[string]any{}
	if err := MaxConfigSnapshot(snapshot, "azure"); err != nil {
		t.Fatalf("build the max-config azure snapshot: %v", err)
	}
	sku, source, creates, err := azureManagedRedisSKUFromSnapshot(snapshot)
	if err != nil {
		t.Fatalf("resolve the sku from the real max-config snapshot: %v", err)
	}
	if !creates {
		t.Fatal("the max-config surface includes the cache kind on azure, so create_azure_cache must be true — a guard that thinks this run provisions no Managed Redis is inert on the exact run it exists for")
	}
	if sku != "Balanced_B0" {
		t.Errorf("sku = %q, want \"Balanced_B0\" — the sku run 33108860073 asked for and was refused. "+
			"If the template's default genuinely moved, update the ledger's evidence in the same change; if it did not, the resolution chain is broken and this gate no longer sees the failing pair.", sku)
	}
	if strings.TrimSpace(source) == "" {
		t.Error("the resolved sku must say where it came from")
	}

	// And end to end: that sku, in the row's default region, is the refusal.
	got := decideAzureManagedRedisCapacity("probe", "westeurope", sku, azureRPLocationsSample, nil, false)
	if got.Verdict != preflightRefuse {
		t.Errorf("the real max-config sku in the row's DEFAULT region must be refused before any spend; got %s\ndetail: %s", got.Verdict, got.Detail)
	}
}

// TestAzureManagedRedisSnapshotWithNoCacheIsNotAnUnknown — a run that provisions no cache has no
// capacity question, and must not report one.
func TestAzureManagedRedisSnapshotWithNoCacheIsNotAnUnknown(t *testing.T) {
	sku, _, creates, err := azureManagedRedisSKUFromSnapshot(map[string]any{"cluster": map[string]any{"instance_types": []any{"Standard_E2s_v3"}}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if creates {
		t.Error("a snapshot with no caches must not report that a Managed Redis will be created")
	}
	if sku != "" {
		t.Errorf("sku = %q — there is no cache, so there is no sku", sku)
	}
}

// TestT2RequireAzureManagedRedisPreflightApplicability pins the two NOT-APPLICABLE paths. Both
// return an EMPTY message, and that emptiness is deliberate: a check that cannot apply must not
// print a verdict that reads like one that ran. Neither path may ever shell out to `az`, which is
// also why these are the only wrapper paths a unit test drives.
func TestT2RequireAzureManagedRedisPreflightApplicability(t *testing.T) {
	ctx := context.Background()
	for _, provider := range []string{"aws", "gcp", "hetzner", "alibaba"} {
		fatal, msg := t2RequireAzureManagedRedisPreflight(ctx, provider, "eu-central-1", map[string]any{})
		if fatal || msg != "" {
			t.Errorf("%s: want a silent no-op (this probe is azure-only); got fatal=%v msg=%q", provider, fatal, msg)
		}
	}
	// azure, but the run provisions no cache.
	if fatal, msg := t2RequireAzureManagedRedisPreflight(ctx, "azure", "westeurope", map[string]any{}); fatal || msg != "" {
		t.Errorf("an azure run with no cache has no capacity question; got fatal=%v msg=%q", fatal, msg)
	}
}

// TestT2RequireAzureManagedRedisPreflightUnreadableSnapshotSpeaks — the failure branch of the
// resolver. A snapshot this guard cannot read must report UNKNOWN out loud, NOT fall silent:
// silence here is indistinguishable from "this run creates no cache".
func TestT2RequireAzureManagedRedisPreflightUnreadableSnapshotSpeaks(t *testing.T) {
	// `caches` typed as a string cannot decode into []ProjectCacheConfig.
	fatal, msg := t2RequireAzureManagedRedisPreflight(context.Background(), "azure", "westeurope",
		map[string]any{"caches": "not a list"})
	if fatal {
		t.Error("an unreadable snapshot must never red a run — it is a probe that did not answer")
	}
	if !strings.Contains(msg, string(preflightUnknown)) || !strings.Contains(msg, "nothing was checked") {
		t.Errorf("an unreadable snapshot must say UNKNOWN and say nothing was checked; got %q", msg)
	}
}

// TestAzureRedisPreflightTimeoutIsAboveTheMeasuredFloor — the sibling azure gate was INERT on
// every run because its 30s bound was below the measured 36.5s the CLI needed, and it reported
// UNKNOWN while never once running. Pinning the bound keeps that from being reintroduced by a
// tidy-up that "shares the constant".
func TestAzureRedisPreflightTimeoutIsAboveTheMeasuredFloor(t *testing.T) {
	if azureRedisPreflightTimeout < 60*time.Second {
		t.Errorf("azureRedisPreflightTimeout = %s — below 60s risks the same silently-inert gate `az` produced at 30s", azureRedisPreflightTimeout)
	}
	if preflightTimeout >= azureRedisPreflightTimeout {
		t.Error("the azure bound exists precisely because it must be looser than the shared one")
	}
}

// TestPreflightCLIStringsWithinRespectsItsBound — the helper the azure probe needs. A bound that
// is silently clamped to the shared 30s would recreate the inert gate; assert the parameter is
// actually the one in force by driving a command that outlives a SHORT bound.
func TestPreflightCLIStringsWithinRespectsItsBound(t *testing.T) {
	// Resolve the binary FIRST. Without this the test passes when `sleep` is simply absent —
	// exec would fail instantly, the error would be non-nil, and the bound would never have been
	// exercised at all. That is this repository's dominant defect class applied to its own tests.
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("no sleep binary to bound: %v", err)
	}
	start := time.Now()
	got, err := preflightCLIStringsWithin(context.Background(), 200*time.Millisecond, "sleep", "10")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatalf("a 200ms bound must cut a 10s command short; got %v", got)
	}
	// The VALUE that proves the bound was the one in force: had the parameter been ignored and
	// the shared 30s constant used, this would have taken 10s.
	if elapsed > 5*time.Second {
		t.Errorf("the command ran for %s under a 200ms bound — the timeout parameter is not the one in force, which is how the sibling azure gate ended up silently inert", elapsed)
	}
	if got != nil {
		t.Errorf("a failed probe must return NIL, never an empty slice — empty is an ANSWER and would refuse the run; got %#v", got)
	}
}
