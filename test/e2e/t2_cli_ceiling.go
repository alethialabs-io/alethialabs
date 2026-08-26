// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// CEILING SATISFACTION — the missing half of the CloudManual verdict.
//
// t2_cli_demo.go records that a step needs a human because no cloud API can reach it. That is a
// permanent fact about the cloud. What it could not record is the OTHER fact, which changes: whether
// the human has actually done it.
//
// The cost of collapsing those two was measured. On 2026-08-26 the CLI-only demo bar was FAILing on
// every cloud, on every run, with ZERO CLI gaps — the whole failure was two ceilings, and by then
// both had been satisfied:
//
//   - dns-delegation (#1773, CLOSED): e2e.alethialabs.io is delegated, ACM has ISSUED against it,
//     and E2E_ACM_CERT / _ZONE_ID / _ZONE_NAME are all wired.
//   - hetzner-s3-keys (#2332, CLOSED): HETZNER_S3_ACCESS_KEY and _SECRET_KEY were set 2026-08-25.
//
// The bar had no way to learn either fact, so it dead-ended: the one number that answers "can this
// product be driven from the terminal?" said no, for a reason that was no longer true, and no amount
// of engineering on the CLI could have moved it.
//
// A ceiling is therefore now two claims, and BOTH are checked:
//
//	the cloud offers no API for this        — the Why, a fact about the cloud, reviewed by a human
//	and it has / has not been done anyway   — the SatisfiedBy probe, evaluated on every run
//
// A satisfied ceiling passes the bar and is still PRINTED as a ceiling, because the prospect
// evaluating Alethia deserves to know the manual step exists before they hit it.
//
// This is also the product shape, not only the test's. A customer landing on any of these clouds
// hits the same handful of things only they can do. Telling them precisely what those are and
// detecting when they are done is a feature; failing forever with no way to report completion is
// what the bar was doing to itself.
//
// ── WHY A PROBE AND NOT A BOOLEAN ──
//
// `Satisfied: true` in the table would be an author asserting the outcome, which is the exact shape
// PROGRAMME.md §3 forbids ("Never promote a cell by asserting it"). Every probe here reads something
// OUTSIDE this file that would be false if the work had not been done.

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

// CeilingProbeKind names HOW a ceiling's satisfaction is established. A closed set; the zero value
// is invalid on purpose, exactly as CLIReach's is.
type CeilingProbeKind string

const (
	// ProbeEnvTruthy — every named variable must be present AND truthy.
	//
	// TRUTHY, not merely present, and the distinction is the whole point. The workflow renders
	// these as `${{ secrets.X != '' }}`, which yields the STRING "false" when the secret is
	// missing — a presence check would read that as satisfied and turn a red ceiling green with
	// the value that means "no". This is the same class of defect as a guard whose "nothing found"
	// branch is indistinguishable from its "nothing wrong" branch.
	//
	// The variables carry a boolean rendered from a secret, never the secret. Nothing in this file
	// should ever be able to print a credential.
	ProbeEnvTruthy CeilingProbeKind = "env_truthy"
	// ProbeZoneDelegated — the DNS zone named by an environment variable resolves to a non-empty
	// authoritative name-server set on the PUBLIC internet.
	//
	// This is the strongest probe available, because it asks the internet rather than asking us.
	// Delegation is precisely what #1773 was about, and precisely what a hosted zone alone does not
	// establish: a zone that exists in an account but that nothing delegates to has no NS record at
	// the parent, and DNS validation can never succeed against it.
	ProbeZoneDelegated CeilingProbeKind = "zone_delegated"
)

// CeilingProbe is the evidence that a CloudManual step's manual work has been done. It is REQUIRED
// on every CloudManual step: a ceiling nobody can check is indistinguishable from a ceiling nobody
// has met, and the indistinguishable pair is what cost the bar a month of false reds.
//
// A probe that cannot be satisfied yet is still a valid probe — it names what completion would look
// like. That is strictly better than omitting one, which names nothing.
type CeilingProbe struct {
	Kind CeilingProbeKind
	// Env are the environment variable NAMES the probe reads. For ProbeEnvTruthy, all of them must
	// be truthy. For ProbeZoneDelegated, exactly one, naming the zone to look up.
	Env []string
	// Expect describes, in words a maintainer can act on, what satisfying this probe requires.
	// Rendered in the summary next to an UNSATISFIED ceiling, so the bundle says what to DO.
	Expect string
}

// Validate rejects a probe that could not detect its own failure.
func (p *CeilingProbe) Validate(stepID string) error {
	if p == nil {
		return fmt.Errorf("step %q: verdict %q needs a SatisfiedBy probe — a ceiling nobody can check reads exactly like a ceiling nobody has met, and the bar spent a month red on that ambiguity", stepID, CloudManual)
	}
	if p.Expect == "" {
		return fmt.Errorf("step %q: SatisfiedBy needs an Expect naming what completion looks like — an unsatisfied probe with no remedy is a dead end, which is the thing being fixed", stepID)
	}
	switch p.Kind {
	case ProbeEnvTruthy:
		if len(p.Env) == 0 {
			return fmt.Errorf("step %q: probe %q names no variables, so it can never be unsatisfied", stepID, p.Kind)
		}
	case ProbeZoneDelegated:
		if len(p.Env) != 1 {
			return fmt.Errorf("step %q: probe %q takes exactly one variable naming the zone, got %d", stepID, p.Kind, len(p.Env))
		}
	case "":
		return fmt.Errorf("step %q: SatisfiedBy states no Kind — the zero value is invalid on purpose, so an unfilled probe fails loudly instead of reading as unsatisfied", stepID)
	default:
		return fmt.Errorf("step %q: SatisfiedBy has unknown Kind %q", stepID, p.Kind)
	}
	for _, name := range p.Env {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("step %q: SatisfiedBy names an empty variable", stepID)
		}
	}
	return nil
}

// lookupNS is the DNS seam. A package variable so the pure tests can drive every branch — including
// the error branch — without a network, which is what lets ci.yml run them on every PR.
var lookupNS = func(ctx context.Context, zone string) ([]*net.NS, error) {
	var r net.Resolver
	return r.LookupNS(ctx, zone)
}

// probeTimeout bounds the live lookup. A hung resolver must not hang the bar; it must report
// UNSATISFIED, which is the fail-closed direction.
const probeTimeout = 10 * time.Second

// Evaluate reports whether the manual work has been done, with the evidence that says so.
//
// FAIL-CLOSED IN EVERY DIRECTION. An unset variable, a falsey variable, an empty answer, a resolver
// error and a timeout ALL return false. The only path to true is a positive reading. A probe that
// treated "I could not tell" as satisfied would re-create the defect this file exists to remove,
// pointing the other way.
func (p *CeilingProbe) Evaluate(ctx context.Context) (bool, string) {
	if p == nil {
		return false, "no probe"
	}
	switch p.Kind {
	case ProbeEnvTruthy:
		var missing []string
		for _, name := range p.Env {
			if !t2Truthy(strings.TrimSpace(os.Getenv(name))) {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			return false, fmt.Sprintf("not set: %s", strings.Join(missing, ", "))
		}
		return true, fmt.Sprintf("present: %s", strings.Join(p.Env, ", "))
	case ProbeZoneDelegated:
		zone := strings.TrimSpace(os.Getenv(p.Env[0]))
		if zone == "" {
			return false, fmt.Sprintf("%s is unset — no zone to check", p.Env[0])
		}
		ctx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		ns, err := lookupNS(ctx, zone)
		if err != nil {
			return false, fmt.Sprintf("%s: NS lookup failed: %v", zone, err)
		}
		if len(ns) == 0 {
			// A zone that exists in a cloud account but that nothing delegates to answers with an
			// empty set. That is the exact state #1773 described, and it must not read as success.
			return false, fmt.Sprintf("%s: no authoritative name servers — a hosted zone is not a delegated one", zone)
		}
		hosts := make([]string, 0, len(ns))
		for _, n := range ns {
			hosts = append(hosts, strings.TrimSuffix(n.Host, "."))
		}
		return true, fmt.Sprintf("%s delegated to %s", zone, strings.Join(hosts, ", "))
	default:
		return false, fmt.Sprintf("unknown probe kind %q", p.Kind)
	}
}

// SatisfiedCeiling is one ceiling that has been met, and the evidence that met it.
type SatisfiedCeiling struct {
	Step     DemoStep
	Evidence string
}

// EvaluateCeilings runs every ceiling's probe and returns a proof with the satisfied ones moved out
// of Manual and into Satisfied. It is a PURE-IN, IMPURE-OUT boundary: ScoreCLIDemo stays free of
// network so ci.yml can check the table's shape on every PR for nothing, and only the real-binary
// half calls this.
//
// The direction is deliberate: a caller that FORGETS to call this gets the old behaviour, where
// every ceiling fails the bar. Forgetting makes the bar stricter, never laxer.
func (p CLIDemoProof) EvaluateCeilings(ctx context.Context) CLIDemoProof {
	out := p
	out.Manual = nil
	out.Satisfied = nil
	for _, s := range p.Manual {
		ok, evidence := s.SatisfiedBy.Evaluate(ctx)
		if ok {
			out.Satisfied = append(out.Satisfied, SatisfiedCeiling{Step: s, Evidence: evidence})
			continue
		}
		// Carry the reading forward so an unsatisfied ceiling says WHY it is unsatisfied rather
		// than only that it is. "Not done" and "could not tell" are different remedies.
		s.ProbeReading = evidence
		out.Manual = append(out.Manual, s)
	}
	return out
}
