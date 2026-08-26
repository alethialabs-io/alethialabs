// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 PRE-SPEND PREFLIGHT — ask the cloud whether it can fill the order, BEFORE the apply.
//
// WHY THIS EXISTS, measured. On 2026-08-25 two hetzner runs died five minutes into a paid
// apply with `resource is currently unavailable (resource_unavailable)` on every node. The
// answer was one free API call away: `cx33` is SUPPORTED in nbg1 and AVAILABLE in no
// datacenter Hetzner operates. Nothing in the type's own metadata says so — it is not
// deprecated, and it is a real, valid type — so only the per-datacenter availability list
// can tell you. The obvious next move, which the workflow's `region` input invites, was to
// retry in fsn1; fsn1's available list is EMPTY, so that run could not have worked either.
// Two paid failures and a third avoided, for a GET.
//
// The seam this hangs off already existed: `t2Provider.credsPresent` refuses a run before
// any spend when a credential is missing, and `hetznerCredsPresent`'s own comment argues the
// case — "Pre-spend was available the whole time — this seam runs before anything is
// created". A credential is not the only thing that can be absent. Capacity is the other.
//
// THREE VERDICTS, NEVER TWO. A guard whose "nothing found" branch is indistinguishable from
// its "nothing wrong" branch is this repository's dominant defect class, so:
//
//	PROCEED  the cloud listed the shape as available in the target location
//	REFUSE   the cloud answered, and the shape is not in the list — hard-fail, no spend
//	UNKNOWN  the probe itself did not answer — proceed, loudly, and record it
//
// UNKNOWN must never collapse into PROCEED. A transient API blip must not red the nightly,
// and it must not masquerade as a clean check either: the run summary says the check did not
// run, so a green run is never read as "capacity was verified" when nothing verified it.
//
// The inverse collapse is just as wrong and is the reason `available` is a nil-vs-empty
// distinction rather than a length test. fsn1 really does report an EMPTY availability list.
// An empty list is an ANSWER — refuse. A nil list is the absence of one — unknown.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// preflightVerdict is one of three outcomes. Values are stable: they are printed into the
// job log and folded into the run summary, which is committed to a proof bundle.
type preflightVerdict string

const (
	// preflightProceed — the cloud answered and the shape is available.
	preflightProceed preflightVerdict = "PROCEED"
	// preflightRefuse — the cloud answered and the shape is NOT available. Hard-fail
	// before any resource is created.
	preflightRefuse preflightVerdict = "REFUSE"
	// preflightUnknown — the probe did not get an answer. Proceed, but say so.
	preflightUnknown preflightVerdict = "UNKNOWN"
)

// preflightResult is one preflight check's outcome.
type preflightResult struct {
	Verdict preflightVerdict `json:"verdict"`
	// Probe names what was actually asked, so a reader can repeat it by hand.
	Probe string `json:"probe"`
	// Detail is a human sentence and is ALWAYS non-empty — including on PROCEED, where it
	// records what was checked. A check whose success says nothing cannot be told apart
	// from a check that never ran.
	Detail string `json:"detail"`
}

// preflightTimeout bounds one probe. Generous for an HTTP GET and far below any apply.
const preflightTimeout = 30 * time.Second

// azurePreflightTimeout is azure's own bound, and it is not 30s for a measured reason: enumerating
// westeurope's virtualMachines SKUs returns 1114 entries and takes 36.5s. Under the shared bound
// EVERY azure run reported `az: signal: killed`, so the gate reported UNKNOWN and never actually
// ran — inert on a whole cloud, and only visible because UNKNOWN says what it did not check.
// 90s is ~2.5x the measured time, which leaves room for a slower runner without approaching the
// several MINUTES an apply would take to discover the same fact.
const azurePreflightTimeout = 90 * time.Second

// decideTypeAvailability is the PURE core: given what the cloud said about a location, is
// the wanted machine shape available there?
//
// `available` carries the nil/empty distinction deliberately:
//
//   - nil     the probe produced no list at all           → UNKNOWN
//   - []      the cloud listed the location as empty      → REFUSE
//   - [a, b]  a real list                                 → PROCEED / REFUSE by membership
//
// Collapsing those two empties is the whole bug class this file guards against, in both
// directions: treating nil as empty would red a run on a network blip, and treating empty as
// nil would wave through fsn1, which can fill no order at all.
func decideTypeAvailability(probe, want, location string, available []string, probeErr error) preflightResult {
	r := preflightResult{Probe: probe}
	switch {
	case probeErr != nil:
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("could not ask the cloud whether %q is available in %s (%v) — proceeding UNVERIFIED; if the apply fails on capacity, this is why", want, location, probeErr)
		return r
	case available == nil:
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("the availability probe for %s returned no list at all — proceeding UNVERIFIED; %q was NOT checked", location, want)
		return r
	case strings.TrimSpace(want) == "":
		// Nothing to check is not the same as a clean check.
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("no machine type was resolved for %s, so nothing was checked against the %d type(s) the cloud offers there", location, len(available))
		return r
	}
	for _, a := range available {
		if a == want {
			r.Verdict = preflightProceed
			r.Detail = fmt.Sprintf("%q is available in %s (the cloud lists %d available type(s) there)", want, location, len(available))
			return r
		}
	}
	r.Verdict = preflightRefuse
	offer := renderOffer(available)
	r.Detail = fmt.Sprintf("%q is NOT available in %s. Available there: %s. "+
		"This is refused BEFORE any spend: an apply would create part of the cluster and then fail on capacity, "+
		"which is what happened twice on 2026-08-25. Pick an available type, or a location that has this one.",
		want, location, offer)
	return r
}

// preflightOfferSample bounds how many alternatives a REFUSE lists. A managed cloud offers
// hundreds of SKUs in one region; printing all of them buries the finding in its own evidence.
const preflightOfferSample = 12

// renderOffer prints what the location DOES offer, sorted and bounded.
//
// The empty case gets its own sentence rather than an empty tail: "Available there: " followed
// by nothing reads as a truncated message, when it is in fact the most important finding this
// guard can report — it is fsn1, which can fill no order of any kind, and it is the region a
// reader retries in first.
func renderOffer(available []string) string {
	if len(available) == 0 {
		return "NOTHING — the cloud lists no available types in this location at all"
	}
	got := append([]string(nil), available...)
	sort.Strings(got)
	if len(got) <= preflightOfferSample {
		return strings.Join(got, ", ")
	}
	return fmt.Sprintf("%s (+%d more)", strings.Join(got[:preflightOfferSample], ", "), len(got)-preflightOfferSample)
}

// hcloudDatacenter is the subset of `GET /v1/datacenters` the preflight reads.
type hcloudDatacenter struct {
	Name     string `json:"name"`
	Location struct {
		Name string `json:"name"`
	} `json:"location"`
	ServerTypes struct {
		// Available is the ONLY field that answers the question. `Supported` is a
		// superset and is what makes this trap invisible: cx33 is supported in nbg1 and
		// available nowhere, which is exactly why the failure reads `resource_unavailable`
		// rather than an invalid-type error.
		Available []int64 `json:"available"`
		Supported []int64 `json:"supported"`
	} `json:"server_types"`
}

// hcloudServerType is the subset of `GET /v1/server_types` the preflight reads.
type hcloudServerType struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// hcloudAvailableTypeNames maps the two Hetzner payloads onto the pure decision's input:
// the NAMES available in one location. Split from the HTTP calls so the id→name join —
// which is where this is easy to get quietly wrong — is unit-tested without a network.
//
// `location` matches either the LOCATION name (nbg1) or the DATACENTER name (nbg1-dc3):
// the workflow's region input and the template both speak locations, the API answers in
// datacenters, and a caller should not have to know which.
//
// Returns nil (not an empty slice) when no datacenter matched — "we did not find the place
// you named" is not "the place you named is empty", and the two must not decide alike.
func hcloudAvailableTypeNames(dcs []hcloudDatacenter, types []hcloudServerType, location string) []string {
	nameByID := make(map[int64]string, len(types))
	for _, t := range types {
		nameByID[t.ID] = t.Name
	}
	location = strings.TrimSpace(location)
	var out []string
	matched := false
	for _, dc := range dcs {
		if dc.Name != location && dc.Location.Name != location {
			continue
		}
		matched = true
		for _, id := range dc.ServerTypes.Available {
			if n, ok := nameByID[id]; ok {
				out = append(out, n)
			}
		}
	}
	if !matched {
		return nil
	}
	if out == nil {
		// Matched, and genuinely empty. Return a non-nil empty slice so the decision
		// REFUSES rather than reporting UNKNOWN — this is fsn1, and it is an answer.
		return []string{}
	}
	return out
}

// hcloudGetJSON performs one authenticated GET against the Hetzner Cloud API and decodes it.
// The token is only ever placed in the Authorization header — never logged, never returned.
func hcloudGetJSON(ctx context.Context, token, path string, out any) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("HCLOUD_TOKEN is empty")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.hetzner.cloud/v1/"+strings.TrimPrefix(path, "/"), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		// Deliberately does not echo the body.
		return fmt.Errorf("hcloud GET /v1/%s returned status %d", strings.TrimPrefix(path, "/"), resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

// hcloudMaxTypePages bounds the server-type pagination walk. At 50 per page this covers 500
// types against the ~24 Hetzner offers — a runaway guard, not a limit anyone should reach.
const hcloudMaxTypePages = 10

// hcloudAllServerTypes fetches EVERY server type, following pagination.
//
// This is not defensive padding. `GET /v1/server_types` pages at 25 by default and Hetzner
// already publishes 24, so the very next type they add would truncate page one — and a NAME
// missing from the id→name map makes its id unresolvable, drops it from the available list, and
// turns a perfectly provisionable type into a REFUSE that stops a run for no reason. A guard
// that fails in the direction of blocking good work is not a safer guard.
//
// A page that reports a successor beyond the bound is an ERROR, never a short list: a truncated
// answer must read as UNKNOWN ("we did not see them all"), not as a complete one.
func hcloudAllServerTypes(ctx context.Context, token string) ([]hcloudServerType, error) {
	var all []hcloudServerType
	for page := 1; page <= hcloudMaxTypePages; page++ {
		var resp struct {
			ServerTypes []hcloudServerType `json:"server_types"`
			Meta        struct {
				Pagination struct {
					// NextPage is null on the last page, which is why it is a pointer:
					// a plain int would read 0 and be indistinguishable from "not sent".
					NextPage *int `json:"next_page"`
				} `json:"pagination"`
			} `json:"meta"`
		}
		if err := hcloudGetJSON(ctx, token, fmt.Sprintf("server_types?per_page=50&page=%d", page), &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.ServerTypes...)
		if resp.Meta.Pagination.NextPage == nil {
			return all, nil
		}
	}
	return nil, fmt.Errorf("hcloud server_types still reported a next page after %d pages of 50 — refusing to decide on a truncated type list", hcloudMaxTypePages)
}

// hetznerCapacityPreflight asks Hetzner whether the resolved node type has capacity in the
// target location, and refuses the run before any spend when it does not.
func hetznerCapacityPreflight(ctx context.Context, location, wantType string) preflightResult {
	const probe = "hcloud GET /v1/datacenters + /v1/server_types (server_types.available)"
	ctx, cancel := context.WithTimeout(ctx, preflightTimeout)
	defer cancel()

	token := os.Getenv("HCLOUD_TOKEN")
	var dcResp struct {
		Datacenters []hcloudDatacenter `json:"datacenters"`
	}
	if err := hcloudGetJSON(ctx, token, "datacenters", &dcResp); err != nil {
		return decideTypeAvailability(probe, wantType, location, nil, err)
	}
	types, err := hcloudAllServerTypes(ctx, token)
	if err != nil {
		return decideTypeAvailability(probe, wantType, location, nil, err)
	}
	return decideTypeAvailability(probe, wantType, location,
		hcloudAvailableTypeNames(dcResp.Datacenters, types, location), nil)
}

// ── The managed clouds ───────────────────────────────────────────────────────────────────────
//
// Hetzner answers over plain HTTP with the ambient token. The three managed clouds each have a
// first-party CLI already installed and already authenticated in the job (the cleanup scripts
// use them), and no SDK dependency in this module — so the probe shells out to the CLI rather
// than adding three cloud SDKs to `test/e2e/go.mod` for one read each.
//
// A missing binary, an unauthenticated CLI and a malformed answer all surface as UNKNOWN, which
// is the honest verdict: the check did not run. None of them may red a nightly, and none of them
// may be reported as a clean check.

// preflightCLIStrings runs one read-only CLI command that prints a JSON array of strings, and
// decodes it.
//
// Returns (nil, err) on ANY failure — including an exit code, an unparseable body, or an array
// containing a non-string. The caller turns that into UNKNOWN. It never returns an empty slice
// alongside an error: nil-with-error and empty-without-error are the two different answers the
// decision depends on telling apart.
func preflightCLIStrings(ctx context.Context, name string, args ...string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, preflightTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		// Deliberately does not echo stderr: a cloud CLI is happy to print a token or a
		// signed URL into it, and this text reaches the job log.
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	var got []string
	if err := json.Unmarshal(out, &got); err != nil {
		return nil, fmt.Errorf("%s: response is not a JSON array of strings: %w", name, err)
	}
	if got == nil {
		// `null` decodes into a nil slice without error, and nil means UNKNOWN downstream.
		// An empty ANSWER must arrive as `[]`, and it does.
		return nil, fmt.Errorf("%s: response was JSON null, not a list", name)
	}
	return got, nil
}

// awsCapacityPreflight asks EC2 which AVAILABILITY ZONES of the target region offer the type.
//
// `describe-instance-type-offerings` is the right question and `describe-instance-types` is
// not: the second says the type EXISTS, the first says this region sells it. That is the same
// supported-vs-available distinction that made the Hetzner failure invisible.
//
// PER-ZONE, and not per-region, because the region-level answer is weaker than it reads. An EKS
// node group lands in specific SUBNETS and therefore specific zones, so a type offered somewhere
// in the region but not in the zone the cluster actually uses passes a region-level check and
// still fails the apply — the exact failure this preflight exists to prevent, surviving on the
// one cloud whose check was coarsest. hetzner asks per datacenter, gcp per zone and azure per
// subscription; this brings aws to the same granularity.
//
// It does NOT resolve the run's own subnets, which are not known here. So a type offered in SOME
// zone still PROCEEDs — but the detail says how many, which is the difference between "this will
// work" and "this can work somewhere in the region".
func awsCapacityPreflight(ctx context.Context, region, wantType string) preflightResult {
	const probe = "aws ec2 describe-instance-type-offerings --location-type availability-zone"
	if strings.TrimSpace(wantType) == "" {
		// Same refusal decideTypeAvailability makes: nothing to check is not a clean check.
		return preflightResult{
			Verdict: preflightUnknown,
			Probe:   probe,
			Detail:  fmt.Sprintf("no machine type was resolved for %s, so nothing was checked", region),
		}
	}
	zones, err := preflightCLIStrings(ctx, "aws", "ec2", "describe-instance-type-offerings",
		"--location-type", "availability-zone", "--region", region,
		"--filters", "Name=instance-type,Values="+wantType,
		"--query", "InstanceTypeOfferings[].Location", "--output", "json")
	return decideZoneAvailability(probe, wantType, region, zones, err)
}

// decideZoneAvailability is decideTypeAvailability's sibling for a probe that returns the
// LOCATIONS offering one type rather than the types offered in one location.
//
// The nil-vs-empty distinction is the same and matters for the same reason: an empty list is the
// cloud saying "no zone here sells it", which is a REFUSAL, while a nil list is the probe having
// produced no answer, which is not. Collapsing them with a length test would turn the strongest
// evidence available into an unverified pass.
func decideZoneAvailability(probe, want, region string, zones []string, probeErr error) preflightResult {
	r := preflightResult{Probe: probe}
	switch {
	case probeErr != nil:
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("could not ask which zones of %s offer %q (%v) — proceeding UNVERIFIED; if the apply fails on capacity, this is why", region, want, probeErr)
	case zones == nil:
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("the zone-availability probe for %s returned no list at all — proceeding UNVERIFIED; %q was NOT checked", region, want)
	case len(zones) == 0:
		r.Verdict = preflightRefuse
		r.Detail = fmt.Sprintf("%q is offered in NO availability zone of %s — the apply will fail on capacity, so it is refused before spending", want, region)
	default:
		r.Verdict = preflightProceed
		r.Detail = fmt.Sprintf("%q is offered in %d availability zone(s) of %s (%s). NOTE: the run's own subnets are not resolved here, so this says the region CAN serve the type, not that the zone this cluster lands in will",
			want, len(zones), region, renderOffer(zones))
	}
	return r
}

// gcpCapacityPreflight asks Compute Engine which machine types exist in the target ZONE.
//
// The T2 gcp row's region IS a zone (europe-west3-a) because a zonal GKE cluster is the cheapest
// shape, so this is a straight zone query. A region handed here matches no zone and the CLI
// returns an empty list — which would REFUSE, wrongly, so the shape is checked first.
func gcpCapacityPreflight(ctx context.Context, zone, wantType string) preflightResult {
	const probe = "gcloud compute machine-types list --zones <zone> --format json(name)"
	if strings.Count(zone, "-") < 2 {
		return preflightResult{
			Verdict: preflightUnknown,
			Probe:   probe,
			Detail: fmt.Sprintf("%q is a region, not a zone — machine-type availability is zonal, so nothing was checked. "+
				"The gcp row's default location is a zone (europe-west3-a) for this reason; a region-shaped ALETHIA_E2E_REGION skips this check rather than answering it wrongly.", zone),
		}
	}
	names, err := gcpMachineTypeNames(ctx, zone)
	return decideTypeAvailability(probe, wantType, zone, names, err)
}

// gcpMachineTypeNames lists the machine types in one zone.
//
// `--format json(name)` yields objects, not the bare string array preflightCLIStrings expects,
// so this decodes its own body. A decode failure is an ERROR and not an empty list: "the answer
// was unreadable" and "the zone offers nothing" are the two states the whole decision turns on.
func gcpMachineTypeNames(ctx context.Context, zone string) ([]string, error) {
	raw, err := gcpMachineTypesRaw(ctx, zone)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Name string `json:"name"`
	}
	if jerr := json.Unmarshal(raw, &rows); jerr != nil {
		return nil, fmt.Errorf("gcloud: machine-type list is not decodable: %w", jerr)
	}
	if rows == nil {
		return nil, errors.New("gcloud: machine-type list decoded to JSON null, not a list")
	}
	// Non-nil even when empty: an empty zone is an ANSWER, and must REFUSE rather than
	// report UNKNOWN.
	names := make([]string, 0, len(rows))
	for _, r := range rows {
		names = append(names, r.Name)
	}
	return names, nil
}

// gcpMachineTypesRaw runs the machine-type list and returns the raw JSON body.
func gcpMachineTypesRaw(ctx context.Context, zone string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, preflightTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gcloud", "compute", "machine-types", "list",
		"--zones", zone, "--format", "json(name)", "--quiet").Output()
	if err != nil {
		return nil, fmt.Errorf("gcloud: %w", err)
	}
	return out, nil
}

// azureSKURestriction is one entry of a SKU's `restrictions` array.
type azureSKURestriction struct {
	// Type is "Location" or "Zone". This is the field the whole decision turns on.
	Type            string   `json:"type"`
	ReasonCode      string   `json:"reasonCode"`
	Values          []string `json:"values"`
	RestrictionInfo struct {
		Locations []string `json:"locations"`
		Zones     []string `json:"zones"`
	} `json:"restrictionInfo"`
}

// azureSKU is the subset of `az vm list-skus` the preflight reads.
type azureSKU struct {
	Name string `json:"name"`
	// LocationInfo says which zones the SKU is OFFERED in, per location. Without it a zone
	// restriction cannot be judged: "restricted in zones 1 and 3" is harmless when the SKU is
	// offered in 1, 2 and 3, and total when it is offered only in 1 and 3.
	LocationInfo []struct {
		Location string   `json:"location"`
		Zones    []string `json:"zones"`
	} `json:"locationInfo"`
	Restrictions []azureSKURestriction `json:"restrictions"`
}

// azureOfferedZones returns the zones a SKU is offered in for one location, or nil when the SKU
// is not zonal there. Nil is meaningful: a non-zonal SKU cannot be zone-restricted out of
// existence, so the caller must not treat "no zones offered" as "no zones left".
func azureOfferedZones(sku azureSKU, region string) []string {
	for _, li := range sku.LocationInfo {
		if strings.EqualFold(li.Location, region) {
			return li.Zones
		}
	}
	return nil
}

// azureSKUUsable reports whether a SKU can be deployed in the target region at all, and why not
// when it cannot.
//
// A NON-EMPTY `restrictions` ARRAY DOES NOT MEAN UNAVAILABLE, and the first version of this probe
// assumed it did. Measured against the live subscription on 2026-08-26:
//
//	Standard_D2s_v3 / westeurope
//	  reasonCode: NotAvailableForSubscription
//	  type:       Zone
//	  restrictionInfo.zones: ["1", "3"]
//
// That SKU is restricted in zones 1 and 3 and perfectly deployable elsewhere in the region — and
// azure/byo run 32895579252 PROVISIONED WITH IT AND PASSED. A `length(restrictions)==0` filter
// calls that unavailable, so the guard would have REFUSED a run that then succeeded. A guard that
// blocks good work is worse than no guard: it gets switched off, and takes the real refusals with it.
//
// So only a LOCATION-scoped restriction covering the target region makes a SKU unusable. A
// ZONE-scoped one leaves the other zones, which is what a non-zonal or unpinned deployment lands in.
// The excluded zones are returned so the caller can say which they are rather than implying none.
func azureSKUUsable(sku azureSKU, region string) (usable bool, why string, zonesExcluded []string) {
	for _, r := range sku.Restrictions {
		switch r.Type {
		case "Location":
			for _, loc := range r.RestrictionInfo.Locations {
				if strings.EqualFold(loc, region) {
					return false, fmt.Sprintf("%s in %s (a LOCATION-scoped restriction — no zone of this region can take it)", r.ReasonCode, loc), nil
				}
			}
			// A Location restriction naming some OTHER region does not concern this run.
		case "Zone":
			zonesExcluded = append(zonesExcluded, r.RestrictionInfo.Zones...)
		default:
			// An unrecognised restriction type is NOT dismissed. Azure may add one, and treating
			// "we do not understand this restriction" as "there is no restriction" is the same
			// mistake in the opposite direction from the one this function was written to fix.
			return false, fmt.Sprintf("unrecognised restriction type %q (%s) — refusing to guess whether it blocks this region", r.Type, r.ReasonCode), nil
		}
	}
	// A Zone restriction covering EVERY zone the SKU is offered in leaves nowhere to place it,
	// and must refuse. Reported by review on #2716: the first version accumulated the excluded
	// zones and returned usable regardless of how many there were, so "restricted in 1, 2 and 3"
	// read the same as "restricted in 1". The aws sibling in this file already refuses the
	// equivalent (`len(zones) == 0` after filtering), and this brings azure into line with it.
	//
	// STRICTLY GUARDED, because a false refusal is the bug this whole function exists to fix. It
	// refuses ONLY when the SKU is genuinely zonal in this region (offered != nil and non-empty)
	// AND every offered zone appears in the excluded set. A non-zonal SKU — offered == nil — is
	// left usable: it cannot be zoned out of existence, and treating an empty offer list as "no
	// zones left" would refuse every SKU in a region without availability zones.
	if offered := azureOfferedZones(sku, region); len(offered) > 0 && len(zonesExcluded) > 0 {
		excluded := make(map[string]struct{}, len(zonesExcluded))
		for _, z := range zonesExcluded {
			excluded[z] = struct{}{}
		}
		remaining := 0
		for _, z := range offered {
			if _, gone := excluded[z]; !gone {
				remaining++
			}
		}
		if remaining == 0 {
			return false, fmt.Sprintf("restricted in EVERY zone it is offered in (%s in %s) — a zone restriction this wide leaves nowhere to place it",
				strings.Join(offered, ", "), region), zonesExcluded
		}
	}
	return true, "", zonesExcluded
}

// azureCapacityPreflight asks whether the target region can deploy the resolved VM SKU.
//
// It reads the WHOLE SKU objects rather than a pre-filtered list of names, because the decision
// needs `restrictions[].type` — see azureSKUUsable for why a name list cannot express it.
//
// `--size` is deliberately NOT used to narrow the query. Measured: the full westeurope list is
// 1114 SKUs and 36.5s; the same call with `--size Standard_D2s_v3` took 40.0s. It filters
// client-side after the same enumeration, so it buys nothing and costs a second round trip.
// The bound below is raised instead — the previous 30s was under the measured floor, which is why
// every azure run reported `az: signal: killed` and the gate never once ran.
func azureCapacityPreflight(ctx context.Context, region, wantType string) preflightResult {
	const probe = "az vm list-skus --resource-type virtualMachines (restrictions inspected by type)"

	cctx, cancel := context.WithTimeout(ctx, azurePreflightTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, "az", "vm", "list-skus",
		"--location", region, "--resource-type", "virtualMachines",
		"--query", "[].{name:name,restrictions:restrictions}", "--output", "json").Output()
	if err != nil {
		return decideTypeAvailability(probe, wantType, region, nil, fmt.Errorf("az: %w", err))
	}
	var skus []azureSKU
	if jerr := json.Unmarshal(out, &skus); jerr != nil {
		return decideTypeAvailability(probe, wantType, region, nil, fmt.Errorf("az: SKU list is not decodable: %w", jerr))
	}
	if skus == nil {
		return decideTypeAvailability(probe, wantType, region, nil, errors.New("az: SKU list decoded to JSON null, not a list"))
	}

	usable := make([]string, 0, len(skus))
	var wantWhy string
	var wantZones []string
	var wantSeen bool
	for _, sku := range skus {
		ok, why, zones := azureSKUUsable(sku, region)
		if sku.Name == wantType {
			wantSeen, wantWhy, wantZones = true, why, zones
		}
		if ok {
			usable = append(usable, sku.Name)
		}
	}

	res := decideTypeAvailability(probe, wantType, region, usable, nil)
	// Enrich the verdict with what the restrictions actually said — "not available" and "not
	// available in zones 1 and 3" are different facts, and only one of them stops a run.
	if res.Verdict == preflightRefuse && wantSeen && wantWhy != "" {
		res.Detail = fmt.Sprintf("%s is refused in %s: %s", wantType, region, wantWhy)
	}
	if res.Verdict == preflightProceed && len(wantZones) > 0 {
		res.Detail += fmt.Sprintf(" — NOTE: restricted in zone(s) %s, so a zone-pinned deployment there would still fail",
			strings.Join(wantZones, ", "))
	}
	return res
}

// capacityPreflightFor dispatches to one cloud's probe. An unknown provider is UNKNOWN, never
// PROCEED: a cloud with no probe has not been checked, and must not read as if it had.
func capacityPreflightFor(ctx context.Context, provider, location, wantType string) preflightResult {
	switch provider {
	case "hetzner":
		return hetznerCapacityPreflight(ctx, location, wantType)
	case "aws":
		return awsCapacityPreflight(ctx, location, wantType)
	case "gcp":
		return gcpCapacityPreflight(ctx, location, wantType)
	case "azure":
		return azureCapacityPreflight(ctx, location, wantType)
	case "alibaba":
		// NAMED, not left to the default branch, because an unnamed exclusion becomes a permanent
		// one and cloud parity is a hard rule here. `aliyun ecs DescribeAvailableResource
		// --DestinationResource InstanceType --ZoneId <zone>` is the equivalent question; it is not
		// wired because the T2 alibaba row is currently blocked ahead of provisioning on a missing
		// AliyunCSDefaultRole, so there is no run to validate the probe against. Deliberate gap with
		// a known shape, reported the same way as any other unchecked run.
		return preflightResult{
			Verdict: preflightUnknown,
			Probe:   "none (alibaba probe not implemented)",
			Detail:  fmt.Sprintf("no capacity probe is wired for alibaba, so %q in %s was NOT checked — the run proceeds UNVERIFIED", wantType, location),
		}
	default:
		return preflightResult{
			Verdict: preflightUnknown,
			Probe:   "none",
			Detail:  fmt.Sprintf("no capacity probe is implemented for provider %q — the run proceeds UNVERIFIED", provider),
		}
	}
}

// snapshotInstanceType reads the machine type the merged config snapshot will actually
// provision: `cluster.instance_types[0]`, the same element every provider's ProviderTfvars
// resolves its pools from (hetzner's moves BOTH pools together; see hetznerProvider).
//
// Returns "" when the snapshot pins none. That is a real state — the floor dimension does not
// pin one and takes the template's default — and it is reported as UNKNOWN rather than guessed:
// re-deriving each provider's default here would be a second source of truth for the one value
// that must not drift. The heavy dimensions, which are the expensive ones, always pin it
// (t2RequireMaxConfigNodeShape refuses them otherwise), so the guard covers exactly the runs
// worth protecting.
func snapshotInstanceType(snapshot map[string]any) string {
	cluster, _ := snapshot["cluster"].(map[string]any)
	if cluster == nil {
		return ""
	}
	types, ok := cluster["instance_types"].([]any)
	if !ok || len(types) == 0 {
		return ""
	}
	s, _ := types[0].(string)
	return strings.TrimSpace(s)
}

// t2RequireCapacityPreflight is the PRE-SPEND capacity gate, and the sibling of
// t2RequireMaxConfigNodeShape: that one asks "is the shape big enough for what we are about to
// assert?", this one asks "will the cloud sell us that shape here at all?".
//
// Returns (fatal, msg) on the same contract. A REFUSE is fatal under ALETHIA_E2E_T2_REQUIRE (the
// nightly) and a warning off CI, exactly as every other prerequisite is. An UNKNOWN is NEVER
// fatal and always speaks: the message is the record that the check did not run, so a green run
// is never mistaken for one whose capacity was verified.
func t2RequireCapacityPreflight(ctx context.Context, provider, location string, snapshot map[string]any) (fatal bool, msg string) {
	want := snapshotInstanceType(snapshot)
	if want == "" {
		return false, fmt.Sprintf("capacity preflight: the snapshot pins no cluster.instance_types, so the template's default for %s was NOT checked against %s — proceeding unverified",
			provider, location)
	}
	res := capacityPreflightFor(ctx, provider, location, want)
	switch res.Verdict {
	case preflightProceed:
		return false, fmt.Sprintf("capacity preflight [%s]: %s (%s)", res.Verdict, res.Detail, res.Probe)
	case preflightRefuse:
		return t2RequireIsHard(), fmt.Sprintf("capacity preflight [%s]: %s (%s)", res.Verdict, res.Detail, res.Probe)
	default:
		return false, fmt.Sprintf("capacity preflight [%s]: %s (%s)", res.Verdict, res.Detail, res.Probe)
	}
}
