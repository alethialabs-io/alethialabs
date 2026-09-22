// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP ZONE FALLBACK — stop pinning the nightly's gcp floor to ONE zone.
//
// ── WHY, measured ──
//
// The gcp floor leg died three times in ten nightlies on cloud CAPACITY in europe-west3-a, the
// single zone the workflow hardcoded:
//
//	35580334231 (09-21)  GCE_STOCKOUT: "The zone 'projects/itgix-adp/zones/europe-west3-a' does
//	                     not have enough resources available to fulfill the request."
//	35074442209 (09-16)  the same GCE_STOCKOUT, same zone
//	34824956659 (09-14)  "Google Compute Engine does not have enough resources available to
//	34681889191 (09-12)  fulfill request: europe-west3." — the same pool, worded regionally
//
// Every one of them burned ~35 minutes inside GKE's IGM wait before the apply gave up, and every
// gcp run that dies at `applying` leaks PVC disks the reaper then sweeps. A stockout is transient
// and zone-local, so the floor being red on all four of those nights is not a fact about the
// product — it is a fact about having exactly one zone to lose.
//
// ── WHY THE EXISTING PREFLIGHT DID NOT CATCH IT, and could not ──
//
// `gcpCapacityPreflight` ran on every one of those nights and said PROCEED. It was not wrong. It
// asks `gcloud compute machine-types list --zones <zone>`, which is a CATALOGUE question — "is
// e2-medium a thing that exists here" — and the catalogue is unchanged by a stockout. On 09-21 it
// reported `"e2-medium" is available in europe-west3-a (the cloud lists 458 available type(s)
// there)` about ninety seconds before the apply was refused for want of one of them.
//
// That is a structural limit, not a gap to plug:
//
//   - Compute Engine publishes no stock API. Nothing free answers "is there an e2-medium spare in
//     europe-west3-a right now". The only questions that reflect stock are a VM create, or a
//     reservation create — both of which ANSWER BY SUCCEEDING, i.e. by spending.
//   - Even those are out of reach here. The e2e provisioner SA (infra/gcp-e2e/e2e-nightly.tf) holds
//     roles/container.admin, compute.networkAdmin and compute.securityAdmin — GKE creates its nodes
//     through the container service agent, so the SA itself has NO compute.instances.create and no
//     compute.reservations.create. An empirical stock probe would 403 today, and granting it is an
//     IAM change a maintainer must apply, not something this harness can assume.
//
// So the preflight keeps doing the job it can do — it still refuses a type the zone does not sell —
// and this file does the only other thing available BEFORE any spend: it stops betting the whole
// leg on one zone.
//
// ── WHAT THIS ACTUALLY BUYS, stated honestly ──
//
// It does NOT detect a stockout, and it cannot. It changes the leg from "red every night europe-
// west3-a is short" to "red only on a night the drawn zone is short", and it gives a re-run a
// different zone for free (see GCPZoneRotationOffset). With three candidate zones and one of them
// stocked out, the expected red nights fall from all of them to about a third.
//
// It also does NOT retry inside a run, deliberately. A second apply costs another ~35 minutes of
// IGM wait plus a full ~46-minute provision, which a floor leg's own ~100m go-timeout cannot
// contain — the ladder in cmd/t2budget would have to move, and a retry that trips the outer cap is
// a worse failure than the one it replaces. The rotation is the part that fits the budget.
//
// ── THE CONSTRAINT THAT MUST NOT BREAK ──
//
// Every candidate is a ZONE. `.github/workflows/e2e-nightly.yml` spells out why: a bare region
// makes the GKE cluster REGIONAL, and a regional cluster's initial_node_count and autoscaling
// min/max are PER ZONE — so europe-west3 would deliver 3 nodes where the floor declares 1, at 3x
// the compute bill, and would skip the zonal capacity preflight as well. #3566 fixed precisely that
// and this must not undo it. ParseGCPZones therefore REFUSES a region-shaped entry rather than
// passing it through, so a fallback list cannot become a cost regression by typo.
package e2e

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// DefaultGCPZones is the fallback list used when nothing overrides it.
//
// All three are zones of europe-west3, and staying inside one region is not laziness: Compute
// Engine prices e2-medium identically across the zones of a region, so rotating costs nothing,
// while moving regions would change the bill AND strand the run's other regional resources. The
// first entry is the zone the workflow used to hardcode, so an un-rotated run is byte-identical to
// the old behaviour.
var DefaultGCPZones = []string{"europe-west3-a", "europe-west3-b", "europe-west3-c"}

// GCPZoneChoiceVerdict records how much the picker actually established about the zone it returned.
//
// Three values, for the same reason the preflight has three: a picker that cannot tell "I confirmed
// this zone sells e2-medium" from "I could not ask and picked the first one" is a guard reporting
// green on an unexamined thing.
type GCPZoneChoiceVerdict string

const (
	// GCPZoneConfirmed — the cloud answered, and this zone lists the wanted machine type.
	// It says NOTHING about stock; see the file header.
	GCPZoneConfirmed GCPZoneChoiceVerdict = "CONFIRMED"
	// GCPZoneUnverified — no candidate could be checked (the probe never answered). A zone is
	// still returned, because a gcloud blip must not red the nightly, but the run must not read
	// this as a clean check either.
	GCPZoneUnverified GCPZoneChoiceVerdict = "UNVERIFIED"
	// GCPZonePinned — an operator named a zone explicitly, so nothing was chosen and nothing
	// was checked here. The per-run preflight still runs against it.
	GCPZonePinned GCPZoneChoiceVerdict = "PINNED"
)

// GCPZoneChoice is the picker's whole answer.
type GCPZoneChoice struct {
	// Zone is the zone the run should use. Always non-empty on a nil error.
	Zone string
	// Verdict says what was established about it.
	Verdict GCPZoneChoiceVerdict
	// Considered lists the candidates in the order they were tried, so a reader can see both
	// which zone won and how many were passed over to reach it.
	Considered []string
	// Detail is a human sentence and is ALWAYS non-empty, including on CONFIRMED.
	Detail string
}

// ParseGCPZones turns a comma- or whitespace-separated list into validated, de-duplicated zones.
//
// It REFUSES a region-shaped entry (see the file header: a region silently triples the node count),
// and it refuses an empty list rather than falling back to a default — a caller that wanted the
// default should pass the default, so "the list was empty" and "the list was europe-west3-a" are
// never the same outcome.
//
// Order is PRESERVED, not sorted: the list is a preference order and the first entry is the
// historical zone.
func ParseGCPZones(raw string) ([]string, error) {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	})
	seen := make(map[string]struct{}, len(fields))
	zones := make([]string, 0, len(fields))
	for _, f := range fields {
		z := strings.ToLower(strings.TrimSpace(f))
		if z == "" {
			continue
		}
		// A GCP zone is "<region>-<letter>", e.g. europe-west3-a, and every region name itself
		// carries exactly one dash (europe-west3, us-east1). So a zone has at least two dashes
		// and a region has one. This is the SAME shape test gcpCapacityPreflight already uses to
		// decide it was handed a region; the two must not disagree about what a zone looks like.
		if strings.Count(z, "-") < 2 {
			return nil, fmt.Errorf(
				"gcp zone list: %q is a region, not a zone — a region makes the GKE cluster REGIONAL, "+
					"which multiplies every node count by the zone count (europe-west3 would deliver 3 nodes "+
					"where the floor declares 1) and skips the zonal capacity preflight. Name a zone, e.g. %q",
				z, z+"-a")
		}
		if _, dup := seen[z]; dup {
			continue
		}
		seen[z] = struct{}{}
		zones = append(zones, z)
	}
	if len(zones) == 0 {
		return nil, fmt.Errorf("gcp zone list: %q contains no zone at all — nothing to choose from", raw)
	}
	return zones, nil
}

// GCPZoneRotationOffset turns a run's identity into a starting index.
//
// Two properties, and the second is the one that matters operationally:
//
//   - Across NIGHTS the offset varies, because GitHub run ids increment globally and consecutive
//     nightlies are nowhere near each other. A zone that is short for a week no longer takes the
//     leg down every night of it.
//   - Across ATTEMPTS of the SAME run the offset is guaranteed to move by exactly one, so
//     "re-run failed jobs" on a stocked-out leg lands in a DIFFERENT zone. That is the recovery
//     path a maintainer already has muscle memory for, and it costs nothing to make it work.
//
// A zero or unparseable run id degrades to offset 0 — the historical zone — which is a fine
// default and never an error: the picker's job is to choose, not to validate CI metadata.
func GCPZoneRotationOffset(runID, runAttempt uint64, n int) int {
	if n <= 0 {
		return 0
	}
	if runAttempt == 0 {
		runAttempt = 1
	}
	return int((runID + runAttempt - 1) % uint64(n))
}

// RotateGCPZones returns candidates starting at offset, preserving the cyclic order.
func RotateGCPZones(zones []string, offset int) []string {
	if len(zones) == 0 {
		return nil
	}
	offset = ((offset % len(zones)) + len(zones)) % len(zones)
	out := make([]string, 0, len(zones))
	out = append(out, zones[offset:]...)
	out = append(out, zones[:offset]...)
	return out
}

// GCPZoneOffersFunc reports the machine types one zone lists, with the SAME nil/empty contract the
// preflight depends on: a nil slice with a nil error is "no answer", an empty slice is the cloud
// saying the zone offers nothing, and a non-nil error is a probe that failed.
type GCPZoneOffersFunc func(ctx context.Context, zone string) ([]string, error)

// ChooseGCPZone walks the candidates in order and returns the first that lists wantType.
//
// The three branches mirror the preflight's three verdicts, per candidate:
//
//	the zone lists the type      → take it, CONFIRMED, stop asking
//	the zone answered without it → skip it, and remember that it ANSWERED
//	the probe did not answer     → skip it for now, and remember it as a fallback
//
// The tie-breaks at the end are where the two failure directions are kept apart:
//
//   - If no zone was confirmed but at least one probe failed, the first such zone is returned
//     UNVERIFIED. A gcloud blip must never red the nightly, and it must never look like a clean
//     check either.
//   - If EVERY zone answered and none sells the type, that is an ANSWER, and it is refused with an
//     error before any spend — the same posture as `preflightRefuse`. An apply would build half a
//     cluster and then fail, which is exactly what this family of guards exists to prevent.
//
// wantType empty is not an error: there is nothing to check, so the first candidate is returned
// UNVERIFIED and the run's own preflight has the last word.
func ChooseGCPZone(ctx context.Context, candidates []string, wantType string, offers GCPZoneOffersFunc) (GCPZoneChoice, error) {
	if len(candidates) == 0 {
		return GCPZoneChoice{}, fmt.Errorf("gcp zone choice: no candidate zones were supplied")
	}
	choice := GCPZoneChoice{Considered: candidates}

	want := strings.TrimSpace(wantType)
	if want == "" {
		choice.Zone = candidates[0]
		choice.Verdict = GCPZoneUnverified
		choice.Detail = fmt.Sprintf(
			"no machine type was resolved, so none of the %d candidate zone(s) was checked for one; "+
				"defaulting to %s unverified", len(candidates), choice.Zone)
		return choice, nil
	}
	if offers == nil {
		choice.Zone = candidates[0]
		choice.Verdict = GCPZoneUnverified
		choice.Detail = fmt.Sprintf(
			"no probe was supplied, so %q was checked in none of the %d candidate zone(s); "+
				"defaulting to %s unverified", want, len(candidates), choice.Zone)
		return choice, nil
	}

	var (
		firstUnknown    string
		firstUnknownErr error
		answeredWithout []string
	)
	for _, zone := range candidates {
		names, err := offers(ctx, zone)
		switch {
		case err != nil:
			if firstUnknown == "" {
				firstUnknown, firstUnknownErr = zone, err
			}
			continue
		case names == nil:
			if firstUnknown == "" {
				firstUnknown, firstUnknownErr = zone, fmt.Errorf("the probe returned no list at all")
			}
			continue
		}
		for _, n := range names {
			if n == want {
				choice.Zone = zone
				choice.Verdict = GCPZoneConfirmed
				choice.Detail = fmt.Sprintf(
					"%s lists %q (%d type(s) offered there); chosen from %d candidate(s) [%s]. "+
						"This is the CATALOGUE, not stock — a GCE_STOCKOUT is invisible to it, which is "+
						"why the list exists at all",
					zone, want, len(names), len(candidates), strings.Join(candidates, " "))
				return choice, nil
			}
		}
		answeredWithout = append(answeredWithout, zone)
	}

	if firstUnknown != "" {
		choice.Zone = firstUnknown
		choice.Verdict = GCPZoneUnverified
		choice.Detail = fmt.Sprintf(
			"no candidate zone could be CONFIRMED to list %q: %d answered without it (%s) and the probe "+
				"failed for %s (%v). Proceeding on %s UNVERIFIED — a probe that did not answer is not an "+
				"answer of \"no\", and must not red the nightly",
			want, len(answeredWithout), renderOffer(answeredWithout), firstUnknown, firstUnknownErr, firstUnknown)
		return choice, nil
	}

	sorted := append([]string(nil), answeredWithout...)
	sort.Strings(sorted)
	return GCPZoneChoice{Considered: candidates}, fmt.Errorf(
		"gcp zone choice: %q is offered in NONE of the %d candidate zone(s) (%s) — every one of them "+
			"ANSWERED, so this is a refusal and not a blind spot. An apply would create part of the cluster "+
			"and then fail on capacity, so it is refused before any spend. Pick a type these zones sell, or "+
			"name zones that sell this one",
		want, len(candidates), strings.Join(sorted, ", "))
}

// GCPMachineTypeNames is the live probe behind ChooseGCPZone, exported so cmd/gcpzone can reach it.
//
// It is the SAME call gcpCapacityPreflight makes, deliberately: the picker and the per-run guard
// must not be able to disagree about what the cloud said. Its nil/empty contract is documented on
// gcpMachineTypeNames and is what ChooseGCPZone's branches turn on.
func GCPMachineTypeNames(ctx context.Context, zone string) ([]string, error) {
	return gcpMachineTypeNames(ctx, zone)
}
