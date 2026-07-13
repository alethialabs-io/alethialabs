// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"sort"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/iacsafety"
)

// BYOC task B5.1 — honesty alignment between the TWO independent allowlists a BYO
// IaC plan is gated by:
//
//  1. iacsafety.DefaultProviderAllowlist() — the provider SOURCE addresses
//     (hashicorp/aws, aliyun/alicloud, …) that `tofu init` is allowed to fetch. A
//     plan built only from these passes the safety scan.
//  2. verify's controlledProviderTokens ∪ supportedNoControlProviderTokens — the
//     resource-type PREFIXES (segment before the first `_`) the fail-closed SOC2
//     gate recognizes. Anything else demotes an otherwise-clean plan to
//     not_evaluable (SCOPE-001 / controlEvaluableScope).
//
// The honesty gap this test guards: if a provider is iacsafety-allowlisted but the
// resource prefix it emits is in NEITHER verify map, a scan-clean BYO IaC plan
// using it sails through the safety scan and then hits the verify gate as
// not_evaluable — a "scan-clean → deploy-gate dead end." This test makes every such
// gap EXPLICIT (knownParityGaps, each justified) and breaks on silent regression in
// BOTH directions: a newly uncovered allowlisted provider must be justified, and a
// gap that gets closed in verify must be removed from the exception set.
//
// SCOPE: this guards the COMMITTED default allowlist (iacsafety.DefaultProviderAllowlist).
// The runtime scanner reads iacsafety.AllowlistFromEnv(), which an operator can override via
// ALETHIA_BYO_IAC_PROVIDER_ALLOWLIST — a provider added ONLY through that env var is a conscious
// out-of-code choice and is intentionally not asserted here (there is nothing committed to check).
//
// HONEST SEVERITY OF A PARITY GAP (read from provisioner.RunDeployV2 in
// packages/core/provisioner/deploy.go + Report.Unwaived in override.go):
// a not_evaluable verdict is NOT a hard `tofu apply` block at the provisioner layer.
// The fail-closed apply path blocks on only two things — (a) Report.Unwaived, which
// collects ONLY StatusFail controls (not StatusNotEvaluable), and (b)
// gateRequiresReport, which refuses only when the report is entirely absent (the plan
// JSON could not be produced), not when a report exists with a not_evaluable verdict.
// So a parity gap degrades the plan to not_evaluable, which is recorded on the signed
// evidence receipt and surfaced in the console Plan tab (a real loss of SOC2 evidence
// / attestation, and a likely trigger for higher approval gates) — but it does not by
// itself fail-closed the apply. The hard block is reserved for a genuine StatusFail.
// The gap is therefore an evidence/honesty degradation to remove, not a hard outage —
// this test's job is to keep it VISIBLE and prevent it growing silently.

// sourceToPrefixes maps every provider SOURCE address in
// iacsafety.DefaultProviderAllowlist() to the verify resource-type PREFIX(es) it
// produces (the segment before the first underscore of the resource types the
// provider emits). Multiple sources can map to the same prefix (google/google-beta
// both emit google_*; the two alicloud mirrors both emit alicloud_*).
//
// This is intentionally EXPLICIT and hand-maintained: TestIACSafetyVerifyParity
// fails if DefaultProviderAllowlist() grows a source with no entry here, forcing a
// conscious mapping decision (and a parity verdict) for every future provider rather
// than a silent hole.
var sourceToPrefixes = map[string][]string{
	// Managed clouds with an authored verify control set.
	"hashicorp/aws":         {"aws"},     // aws_* → controlledProviderTokens
	"hashicorp/google":      {"google"},  // google_* → controlledProviderTokens (gcp)
	"hashicorp/google-beta": {"google"},  // google-beta still emits google_* resources
	"hashicorp/azurerm":     {"azurerm"}, // azurerm_* → controlledProviderTokens (azure)
	"hashicorp/azuread":     {"azuread"}, // azuread_* → controlledProviderTokens (azure)

	// Managed cloud WITHOUT a control set yet → parity gap (see knownParityGaps).
	"hashicorp/alicloud": {"alicloud"}, // alicloud_* — no controls yet (B0.2)
	"aliyun/alicloud":    {"alicloud"}, // same prefix, the canonical registry mirror

	// Cloud without a control-surface BY DESIGN (token auth is the ceiling).
	"hetznercloud/hcloud": {"hcloud"}, // hcloud_* → supportedNoControlProviderTokens

	// Cluster-layer / utility providers with no cloud-authority surface.
	"hashicorp/kubernetes": {"kubernetes"}, // kubernetes_* → supported
	"hashicorp/helm":       {"helm"},       // helm_* → supported
	"hashicorp/tls":        {"tls"},        // tls_* → supported
	"hashicorp/random":     {"random"},     // random_* → supported
	"hashicorp/time":       {"time"},       // time_* → supported
	"hashicorp/local":      {"local"},      // local_* → supported
	"hashicorp/null":       {"null"},       // null_resource → supported

	// Pure-utility providers that LOOK like they belong alongside random/tls/null in
	// supportedNoControlProviderTokens but are currently omitted → parity gaps.
	"hashicorp/cloudinit": {"cloudinit"}, // cloudinit_config — no cloud authority
	"hashicorp/dns":       {"dns"},       // dns_* records — no cloud authority
	"hashicorp/template":  {"template"},  // template_* (deprecated) — no cloud authority
}

// knownParityGaps are the resource prefixes that are iacsafety-allowlisted but
// deliberately/pending NOT covered by verify's controlled ∪ supported maps today.
// Every entry is a scan-clean → not_evaluable path we are consciously accepting for
// now. Each MUST be genuinely uncovered right now (TestIACSafetyVerifyParity's
// anti-regression check fails if a listed gap is actually covered — forcing this set
// to shrink the moment a gap is closed in verify.go).
//
//   - "alicloud": verify deliberately omits Alibaba — it has real RAM/OIDC authority,
//     so it must eventually get a real control set, NOT a vacuous supported-list pass.
//     An Alibaba plan is honestly not_evaluable until BYOC task B0.2 ships
//     controls_alibaba.go. Remove this entry when B0.2 lands.
//   - "cloudinit", "dns", "template": utility providers with no cloud-authority
//     surface that belong alongside random_/tls_/null_ in
//     supportedNoControlProviderTokens but are currently missing → BYO IaC plans using
//     them hit not_evaluable. Tracked follow-up: add them to verify's supported set in
//     a separate verify.go PR (NOT this additive test). Remove each here as it lands.
var knownParityGaps = map[string]string{
	"alicloud":  "no verify control set yet (B0.2 controls_alibaba.go); honest not_evaluable until then",
	"cloudinit": "utility provider, no cloud authority; add to supportedNoControlProviderTokens (verify.go follow-up)",
	"dns":       "utility provider, no cloud authority; add to supportedNoControlProviderTokens (verify.go follow-up)",
	"template":  "utility provider, no cloud authority; add to supportedNoControlProviderTokens (verify.go follow-up)",
}

// prefixCovered reports whether a verify resource-type prefix is recognized by the
// fail-closed gate — i.e. it is in controlledProviderTokens (has a control set) or
// supportedNoControlProviderTokens (a legitimate vacuous pass). A prefix that is in
// neither demotes an otherwise-clean plan to not_evaluable (SCOPE-001).
func prefixCovered(prefix string) bool {
	return controlledProviderTokens[prefix] || supportedNoControlProviderTokens[prefix]
}

// TestIACSafetyVerifyParity asserts the iacsafety provider allowlist and verify's
// recognized-prefix maps stay in honest alignment: every allowlisted source is
// mapped, every mapped prefix is either verify-covered or an explicitly documented
// knownParityGap, and every listed gap is genuinely uncovered right now.
func TestIACSafetyVerifyParity(t *testing.T) {
	// 1. Every allowlisted SOURCE must have a mapping entry — a new provider added to
	//    iacsafety without a verify parity decision fails here (no silent hole).
	t.Run("every_allowlisted_source_is_mapped", func(t *testing.T) {
		for _, src := range iacsafety.DefaultProviderAllowlist() {
			prefixes, ok := sourceToPrefixes[src]
			if !ok {
				t.Errorf("iacsafety allowlist source %q has NO entry in sourceToPrefixes — "+
					"add its verify resource-type prefix(es) and decide parity (covered vs knownParityGap)", src)
				continue
			}
			if len(prefixes) == 0 {
				t.Errorf("sourceToPrefixes[%q] is empty — map it to at least one verify resource-type prefix", src)
			}
		}
	})

	// 2. Parity: every mapped prefix must be verify-covered, UNLESS it is a documented
	//    knownParityGap. An allowlisted provider that silently falls off verify's maps
	//    (scan-clean → not_evaluable dead end) fails here until it is either covered in
	//    verify.go or justified as a gap.
	t.Run("mapped_prefixes_are_covered_or_known_gaps", func(t *testing.T) {
		for _, src := range iacsafety.DefaultProviderAllowlist() {
			for _, prefix := range sourceToPrefixes[src] {
				if prefixCovered(prefix) {
					continue
				}
				if _, gap := knownParityGaps[prefix]; gap {
					continue // consciously accepted, documented gap
				}
				t.Errorf("PARITY GAP: iacsafety source %q emits prefix %q, which is in NEITHER "+
					"verify.controlledProviderTokens NOR verify.supportedNoControlProviderTokens — a scan-clean "+
					"BYO IaC plan using it hits the verify gate as not_evaluable. Either add %q to a verify map "+
					"(verify.go) or add it to knownParityGaps with a justification.", src, prefix, prefix)
			}
		}
	})

	// 3. Anti-regression: every knownParityGap must be genuinely UNCOVERED right now.
	//    If a gap has since been covered in verify.go, this fails — forcing the
	//    exception set to shrink the moment a gap is closed (a stale exception can
	//    never mask a real future gap on the same prefix).
	t.Run("known_gaps_are_actually_uncovered", func(t *testing.T) {
		for prefix := range knownParityGaps {
			if prefixCovered(prefix) {
				t.Errorf("STALE knownParityGap: prefix %q is now covered by a verify map — "+
					"remove it from knownParityGaps (the gap is closed).", prefix)
			}
		}
	})

	// 4. Anti-rot: every knownParityGap must correspond to a prefix that is actually
	//    produced by some allowlisted source. A gap for a prefix nothing emits is dead
	//    documentation that should be pruned.
	t.Run("known_gaps_are_reachable_from_the_allowlist", func(t *testing.T) {
		emitted := map[string]bool{}
		for _, src := range iacsafety.DefaultProviderAllowlist() {
			for _, prefix := range sourceToPrefixes[src] {
				emitted[prefix] = true
			}
		}
		for prefix := range knownParityGaps {
			if !emitted[prefix] {
				t.Errorf("DEAD knownParityGap: prefix %q is not emitted by any source in "+
					"DefaultProviderAllowlist() — remove the stale exception.", prefix)
			}
		}
	})
}

// TestIACSafetyVerifyParity_GapInventory is a non-failing census: it logs the current
// covered set and the exact uncovered (gap) set derived from the live allowlist, so a
// reader sees the honest parity state at a glance in verbose test output.
func TestIACSafetyVerifyParity_GapInventory(t *testing.T) {
	var covered, uncovered []string
	seen := map[string]bool{}
	for _, src := range iacsafety.DefaultProviderAllowlist() {
		for _, prefix := range sourceToPrefixes[src] {
			if seen[prefix] {
				continue
			}
			seen[prefix] = true
			if prefixCovered(prefix) {
				covered = append(covered, prefix)
			} else {
				uncovered = append(uncovered, prefix)
			}
		}
	}
	sort.Strings(covered)
	sort.Strings(uncovered)
	t.Logf("verify-covered prefixes (%d): %v", len(covered), covered)
	t.Logf("uncovered (not_evaluable) prefixes (%d): %v — must all be in knownParityGaps", len(uncovered), uncovered)
}
