// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"math/bits"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// Every numeric floor in validate.go comes from a template literal, and NONE of them is
// hand-mirrored. This file re-derives all of them from the .tf on every run — the same way
// packages/core/compat/couplings_drift_test.go binds the tofu version — so a template bump that
// leaves the Go constant behind reds the build instead of shipping a gate that refuses (or
// admits) the wrong values.
//
// The repo has shipped an INERT guard before: a fidelity check that compared 2 of 35 keys and
// reported a proof it never made. Three properties keep this one honest:
//
//  1. A pattern that does not match is t.Fatalf, NEVER a skip. If the template's format changes,
//     the coupling stops being verifiable and that is a failure, not a pass.
//  2. The tables are COMPLETE over every provisioning cloud. A cloud with no rule is an explicit
//     entry that says why and asserts the reason still holds — a missing rule and a deliberate
//     absence must not look the same, and a rename that drops a cloud must red.
//  3. Every literal was proved non-vacuous by mutation before this landed: the .tf was edited,
//     the test observed to FAIL, and the edit reverted. A guard nobody has watched fail has
//     proved nothing.

// driftClouds is every cloud with a provisioning template. It must stay identical to the list in
// TestEveryRequiredTemplateVarIsEmitted; the tables below are checked for completeness over it.
var driftClouds = []string{"aws", "azure", "gcp", "alibaba", "hetzner"}

// readTemplateSource reads a repo-root-relative template file. A missing file is a HARD failure:
// the coupling source moved or was renamed without this test being re-anchored, which is itself
// the drift the file exists to catch.
func readTemplateSource(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read coupling source %s: %v (source moved? re-anchor this coupling)", rel, err)
	}
	return string(b)
}

// scrapeInt returns the first capture group of re in src as an integer, failing hard when the
// pattern is absent. Same semantics as compat's firstMatch: an unmatched pattern means the
// source's format changed and the coupling is no longer verifiable — never a skip.
func scrapeInt(t *testing.T, src, rel string, re *regexp.Regexp) int {
	t.Helper()
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("pattern %s not found in %s (format changed? re-anchor this coupling)", re, rel)
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		t.Fatalf("captured %q from %s is not an integer: %v", m[1], rel, err)
	}
	return n
}

// scrapeInt2 returns the first two capture groups of re in src as integers, with the same
// fail-hard semantics as scrapeInt.
func scrapeInt2(t *testing.T, src, rel string, re *regexp.Regexp) (int, int) {
	t.Helper()
	m := re.FindStringSubmatch(src)
	if len(m) < 3 {
		t.Fatalf("pattern %s not found in %s (format changed? re-anchor this coupling)", re, rel)
	}
	a, err := strconv.Atoi(m[1])
	if err != nil {
		t.Fatalf("captured %q from %s is not an integer: %v", m[1], rel, err)
	}
	b, err := strconv.Atoi(m[2])
	if err != nil {
		t.Fatalf("captured %q from %s is not an integer: %v", m[2], rel, err)
	}
	return a, b
}

// maxPrefixClearingFirstBlock returns the largest network prefix p (<= firstTarget, so the
// first carve's newbits stay >= 0) under which `cidrsubnet(net, newbits, netnum)` is
// well-formed and its block starts at or past the end of the network's first /firstTarget —
// the arithmetic tofu evaluates, not a re-encoding of a conclusion. Returns -1 when no prefix
// satisfies it (e.g. netnum 0, which IS the first block).
func maxPrefixClearingFirstBlock(firstTarget, newbits, netnum int) int {
	for p := firstTarget; p >= 0; p-- {
		if p+newbits > 32 {
			continue
		}
		blockStart := uint64(netnum) << uint(32-p-newbits)
		firstBlockSize := uint64(1) << uint(32-firstTarget)
		if blockStart >= firstBlockSize {
			return p
		}
	}
	return -1
}

// ---------------------------------------------------------------------------------------------
// Node disk floors
// ---------------------------------------------------------------------------------------------

// diskFloorCoupling binds one Go constant to the `>= N` in that cloud's disk-size variable.
type diskFloorCoupling struct {
	rel      string // repo-relative variables.tf
	variable string // the tofu variable name
	constant int    // the Go constant that must equal the scraped N
}

var nodeDiskFloorCouplings = map[string]diskFloorCoupling{
	"aws":     {"infra/templates/project/aws/variables.tf", "eks_disk_size", awsNodeDiskFloorGB},
	"gcp":     {"infra/templates/project/gcp/variables.tf", "gke_disk_size_gb", gcpNodeDiskFloorGB},
	"azure":   {"infra/templates/project/azure/variables.tf", "aks_disk_size_gb", azureNodeDiskFloorGB},
	"alibaba": {"infra/templates/project/alibaba/variables.tf", "ack_disk_size_gb", alibabaNodeDiskFloorGB},
	// hetzner has no entry ON PURPOSE — its Talos nodes take the server type's own disk. The
	// test below asserts that absence against the template rather than trusting this comment.
}

// TestNodeDiskFloorsMatchTemplates re-derives every node-disk floor from the template that owns
// it, and pins Hetzner's deliberate absence of one.
func TestNodeDiskFloorsMatchTemplates(t *testing.T) {
	root := templateRepoRoot(t)

	for _, cloudName := range driftClouds {
		t.Run(cloudName, func(t *testing.T) {
			coupling, ok := nodeDiskFloorCouplings[cloudName]
			if !ok {
				if cloudName != "hetzner" {
					t.Fatalf("%s has no disk-floor coupling and is not the known exception — a cloud "+
						"was added or renamed and this table was not updated", cloudName)
				}
				// Hetzner's exemption is only true while the template declares no disk-size
				// variable. The day it grows one, ValidateConfig needs a floor for it.
				src := readTemplateSource(t, root, "infra/templates/project/hetzner/variables.tf")
				if regexp.MustCompile(`variable "[a-z0-9_]*disk_size[a-z0-9_]*"`).MatchString(src) {
					t.Fatalf("hetzner now declares a node disk-size variable — add a coupling here and a " +
						"validateNodeDiskSize call to hetznerProvider.ValidateConfig")
				}
				return
			}

			src := readTemplateSource(t, root, coupling.rel)
			re := regexp.MustCompile(`var\.` + regexp.QuoteMeta(coupling.variable) + `\s*>=\s*(\d+)`)
			got := scrapeInt(t, src, coupling.rel, re)
			if got != coupling.constant {
				t.Errorf("%s: %s declares a floor of %d GB but validate.go encodes %d — bump the Go "+
					"constant and the template in lockstep", cloudName, coupling.variable, got, coupling.constant)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------------
// Network CIDR floors
// ---------------------------------------------------------------------------------------------

// cidrFloorKind says how a cloud's network-CIDR floor is derived — including the two ways of
// NOT having one, so a deliberate absence is data the test can check rather than prose.
type cidrFloorKind int

const (
	// `cidrsubnet(x, N - <prefix length>, netnum)` — cidrsubnet() needs BOTH newbits >= 0 AND
	// netnum < 2^newbits, so the floor is N minus the bits the largest carved netnum needs:
	// N - bits.Len(maxNetnum). With a single subnet at netnum 0 that degenerates to N; with
	// netnums 0..3 it is N - 2. Deriving only the newbits half is how #2050 shipped a floor
	// two too wide.
	cidrFloorFromPrefixExpr cidrFloorKind = iota
	// `cidrsubnet(x, N - <prefix length>, 0)` PLUS further fixed-newbits carves out of the SAME
	// network that must each stay disjoint from that first /N block (a fail-closed template
	// precondition). The floor is the narrowest prefix under which every carve is well-formed
	// AND clears the /N — strictly below the scraped N whenever any carve's block slides into
	// it. #2049: deriving only from the node carve admitted /23 and /24, whose service carve
	// lands inside the node /24 and dies at plan.
	cidrFloorFromPrefixExprAndDisjointCarves
	// `cidrsubnet(x, N, …)` — the result runs past /32 once prefix + N > 32, so the floor is
	// 32 - N.
	cidrFloorFromFixedNewbits
	// The CIDR is used verbatim; nothing is carved out of it, so no floor exists to derive.
	cidrFloorVerbatimExempt
	// A carve exists, but the number is owned by another issue and is not encoded here yet.
	cidrFloorDeferred
	// The template states the bound directly as a carvability predicate rather than implying it
	// from a cidrsubnet() newbits argument, so the floor is scraped from that predicate.
	cidrFloorFromCarvableBound
)

// cidrFloorCoupling binds one Go constant (or one documented absence) to a template expression.
type cidrFloorCoupling struct {
	kind     cidrFloorKind
	rel      string         // repo-relative .tf carrying the expression
	pattern  *regexp.Regexp // must match; captures the newbits integer for the carved kinds, plus every carved netnum for the prefix-expr kind
	absent   *regexp.Regexp // for the exempt kind: a pattern that must NOT match
	constant int            // the Go constant, for the carved kinds
	why      string         // for the two non-carved kinds
	// for the disjoint-carves kind: each pattern captures (newbits, netnum) of one further
	// carve out of the same network that must stay disjoint from the first block.
	carves []*regexp.Regexp
}

var networkCIDRFloorCouplings = map[string]cidrFloorCoupling{
	"azure": {
		kind:     cidrFloorFromPrefixExpr,
		rel:      "infra/templates/project/azure/modules/vnet/main.tf",
		pattern:  regexp.MustCompile(`cidrsubnet\(var\.vnet_cidr,\s*(\d+)\s*-\s*local\.vnet_prefix_length,\s*(\d+)\)`),
		constant: azureMaxNetworkPrefix,
	},
	"hetzner": {
		kind:     cidrFloorFromPrefixExprAndDisjointCarves,
		rel:      "infra/templates/project/hetzner/network.tf",
		pattern:  regexp.MustCompile(`cidrsubnet\(local\.network_ip_range,\s*(\d+)\s*-\s*tonumber\(split\("/", local\.network_ip_range\)\[1\]\),\s*(\d+)\)`),
		constant: hetznerMaxNetworkPrefix,
		// The pod/service split — the same one hetznerProvider.ProviderTfvars emits.
		// checks_network.tf (`cidrs_distinct`) blocks the apply fail-closed unless both stay
		// disjoint from the node subnet, so each carve tightens the floor below the node
		// carve's own /24.
		carves: []*regexp.Regexp{
			regexp.MustCompile(`pod_cidr\s*=\s*coalesce\(var\.pod_cidr,\s*cidrsubnet\(local\.network_ip_range,\s*(\d+),\s*(\d+)\)\)`),
			regexp.MustCompile(`service_cidr\s*=\s*coalesce\(var\.service_cidr,\s*cidrsubnet\(local\.network_ip_range,\s*(\d+),\s*(\d+)\)\)`),
		},
	},
	"alibaba": {
		kind:     cidrFloorFromFixedNewbits,
		rel:      "infra/templates/project/alibaba/modules/network/main.tf",
		pattern:  regexp.MustCompile(`cidrsubnet\(var\.network_cidr,\s*(\d+),\s*count\.index\)`),
		constant: alibabaMaxNetworkPrefix,
	},
	"gcp": {
		kind:    cidrFloorVerbatimExempt,
		rel:     "infra/templates/project/gcp/modules/vpc-network/main.tf",
		pattern: regexp.MustCompile(`ip_cidr_range\s*=\s*var\.network_cidr`),
		absent:  regexp.MustCompile(`cidrsubnet\(var\.network_cidr`),
		why:     "the subnetwork takes network_cidr verbatim and pods/services are SECONDARY ranges",
	},
	"aws": {
		kind: cidrFloorFromCarvableBound,
		rel:  "infra/templates/project/aws/networking.tf",
		// #1936 moved the carve behind `local.vpc_cidr_for_subnet_plan` and computed the bound
		// once, as a predicate: public subnets are 1/1024 of the VPC and AWS's minimum subnet is
		// /28, which binds the constraint at 18. That predicate is the single source of the number,
		// so the Go constant is scraped from it rather than re-derived from the newbits — #1942
		// warned explicitly against hand-mirroring the /18, and a second derivation IS a second
		// source of truth.
		pattern:  regexp.MustCompile(`vpc_cidr_is_carvable\s*=\s*local\.vpc_cidr_prefix_length\s*>=\s*\d+\s*&&\s*local\.vpc_cidr_prefix_length\s*<=\s*(\d+)`),
		constant: awsMaxNetworkPrefix,
	},
}

// TestNetworkCIDRFloorsMatchTemplates re-derives every network-CIDR floor from the cidrsubnet()
// expression that implies it, and pins the one cloud that deliberately has no rule — GCP, because
// the subnetwork takes network_cidr verbatim and pods/services are secondary ranges. Every case is
// asserted against the template, so none can quietly stop being true.
//
// AWS was `cidrFloorDeferred` until #1942 encoded its floor; it now scrapes the carvability
// predicate #1936 introduced.
func TestNetworkCIDRFloorsMatchTemplates(t *testing.T) {
	root := templateRepoRoot(t)

	for _, cloudName := range driftClouds {
		t.Run(cloudName, func(t *testing.T) {
			coupling, ok := networkCIDRFloorCouplings[cloudName]
			if !ok {
				t.Fatalf("%s has no network-CIDR coupling — a cloud was added or renamed and this "+
					"table was not updated; a missing rule must never be indistinguishable from a "+
					"deliberate absence", cloudName)
			}

			src := readTemplateSource(t, root, coupling.rel)

			switch coupling.kind {
			case cidrFloorFromPrefixExpr:
				// EVERY carve matters, not just one: the floor is the target prefix N minus the
				// newbits the largest carved netnum needs (netnum < 2^newbits is a hard tofu
				// error, exactly like negative newbits). Matching a single expression here is
				// how azure's floor shipped as /20 while the template carved four subnets
				// (#2050) — so scrape them all, and hard-fail if the template's carves ever
				// disagree on N.
				matches := coupling.pattern.FindAllStringSubmatch(src, -1)
				if matches == nil {
					t.Fatalf("pattern %s not found in %s (format changed? re-anchor this coupling)",
						coupling.pattern, coupling.rel)
				}
				targetPrefix, maxNetnum := 0, 0
				for i, m := range matches {
					n, err := strconv.Atoi(m[1])
					if err != nil {
						t.Fatalf("captured %q from %s is not an integer: %v", m[1], coupling.rel, err)
					}
					if i == 0 {
						targetPrefix = n
					} else if n != targetPrefix {
						t.Fatalf("%s: %s carves at both `%d - <prefix>` and `%d - <prefix>` — the "+
							"subnets no longer share one target prefix, so a single floor cannot be "+
							"derived; re-anchor this coupling", cloudName, coupling.rel, targetPrefix, n)
					}
					netnum, err := strconv.Atoi(m[2])
					if err != nil {
						t.Fatalf("captured %q from %s is not an integer: %v", m[2], coupling.rel, err)
					}
					maxNetnum = max(maxNetnum, netnum)
				}
				if want := targetPrefix - bits.Len(uint(maxNetnum)); want != coupling.constant {
					t.Errorf("%s: %s carves %d subnet(s) at `%d - <prefix>` up to netnum %d, so the "+
						"floor is /%d, but validate.go encodes /%d", cloudName, coupling.rel,
						len(matches), targetPrefix, maxNetnum, want, coupling.constant)
				}

			case cidrFloorFromPrefixExprAndDisjointCarves:
				nodeTarget := scrapeInt(t, src, coupling.rel, coupling.pattern)
				floor := nodeTarget
				for _, carve := range coupling.carves {
					newbits, netnum := scrapeInt2(t, src, coupling.rel, carve)
					p := maxPrefixClearingFirstBlock(nodeTarget, newbits, netnum)
					if p < 0 {
						t.Fatalf("%s: %s carve (%d, %d) can NEVER clear the first /%d — the template's "+
							"split itself is broken, not just the floor", cloudName, coupling.rel,
							newbits, netnum, nodeTarget)
					}
					if p < floor {
						floor = p
					}
				}
				if floor != coupling.constant {
					t.Errorf("%s: %s carves a first /%d plus disjoint blocks whose derived floor is "+
						"/%d, but validate.go encodes /%d", cloudName, coupling.rel, nodeTarget, floor,
						coupling.constant)
				}

			case cidrFloorFromFixedNewbits:
				newbits := scrapeInt(t, src, coupling.rel, coupling.pattern)
				if want := 32 - newbits; want != coupling.constant {
					t.Errorf("%s: %s carves at %d newbits, so the structural floor is /%d, but "+
						"validate.go encodes /%d", cloudName, coupling.rel, newbits, want, coupling.constant)
				}

			case cidrFloorFromCarvableBound:
				got := scrapeInt(t, src, coupling.rel, coupling.pattern)
				if got != coupling.constant {
					t.Errorf("%s: %s declares the CIDR carvable up to /%d, but validate.go encodes "+
						"/%d — the template owns this number and the Go rule must mirror it, never "+
						"re-derive it", cloudName, coupling.rel, got, coupling.constant)
				}

			case cidrFloorVerbatimExempt:
				if !coupling.pattern.MatchString(src) {
					t.Fatalf("pattern %s not found in %s (format changed? re-anchor this coupling)",
						coupling.pattern, coupling.rel)
				}
				if coupling.absent.MatchString(src) {
					t.Errorf("%s was exempt from a CIDR floor because %s, but %s now carves it with "+
						"cidrsubnet() — derive a floor and give %sProvider.ValidateConfig a rule",
						cloudName, coupling.why, coupling.rel, cloudName)
				}

			case cidrFloorDeferred:
				// Nothing to compare — the point is that the carve still EXISTS, so the deferral
				// is still real. If it disappears, the deferred rule is moot and must be closed
				// out rather than left dangling.
				if !coupling.pattern.MatchString(src) {
					t.Fatalf("pattern %s not found in %s: %s no longer carves subnets out of its "+
						"CIDR, so the deferred floor (%s) is stale — close it out",
						coupling.pattern, coupling.rel, cloudName, coupling.why)
				}

			default:
				t.Fatalf("%s has an unknown cidrFloorKind %d", cloudName, coupling.kind)
			}
		})
	}
}

// TestEveryProviderValidatesConfig is the anti-vacuity check on the SEAM itself, as opposed to
// the constants: every cloud must reach ValidateConfig through the public constructor, and every
// cloud must actually refuse something. A provider whose ValidateConfig returned nil
// unconditionally would satisfy the interface and prove nothing.
func TestEveryProviderValidatesConfig(t *testing.T) {
	for _, cloudName := range driftClouds {
		t.Run(cloudName, func(t *testing.T) {
			p, err := NewCloudProvider(cloudName)
			if err != nil {
				t.Fatalf("NewCloudProvider(%q): %v", cloudName, err)
			}
			if err := p.ValidateConfig(realisticConfig()); err != nil {
				t.Fatalf("a realistic known-good config was REFUSED by %s: %v", cloudName, err)
			}
			bad := realisticConfig()
			bad.Cluster.NodeDesiredSize = bad.Cluster.NodeMaxSize + 1
			if err := p.ValidateConfig(bad); err == nil {
				t.Errorf("%s accepted node_desired_size=%d above node_max_size=%d — ValidateConfig "+
					"is not wired to the shared rules", cloudName, bad.Cluster.NodeDesiredSize,
					bad.Cluster.NodeMaxSize)
			}
		})
	}
}
