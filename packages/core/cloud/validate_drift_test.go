// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
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
	// `cidrsubnet(x, N - <prefix length>, …)` — newbits >= 0 requires prefix <= N, so the floor
	// IS the scraped N.
	cidrFloorFromPrefixExpr cidrFloorKind = iota
	// `cidrsubnet(x, N, …)` — the result runs past /32 once prefix + N > 32, so the floor is
	// 32 - N.
	cidrFloorFromFixedNewbits
	// The CIDR is used verbatim; nothing is carved out of it, so no floor exists to derive.
	cidrFloorVerbatimExempt
	// A carve exists, but the number is owned by another issue and is not encoded here yet.
	cidrFloorDeferred
)

// cidrFloorCoupling binds one Go constant (or one documented absence) to a template expression.
type cidrFloorCoupling struct {
	kind     cidrFloorKind
	rel      string         // repo-relative .tf carrying the expression
	pattern  *regexp.Regexp // must match; captures the newbits integer for the two carved kinds
	absent   *regexp.Regexp // for the exempt kind: a pattern that must NOT match
	constant int            // the Go constant, for the two carved kinds
	why      string         // for the two non-carved kinds
}

var networkCIDRFloorCouplings = map[string]cidrFloorCoupling{
	"azure": {
		kind:     cidrFloorFromPrefixExpr,
		rel:      "infra/templates/project/azure/modules/vnet/main.tf",
		pattern:  regexp.MustCompile(`cidrsubnet\(var\.vnet_cidr,\s*(\d+)\s*-\s*local\.vnet_prefix_length`),
		constant: azureMaxNetworkPrefix,
	},
	"hetzner": {
		kind:     cidrFloorFromPrefixExpr,
		rel:      "infra/templates/project/hetzner/network.tf",
		pattern:  regexp.MustCompile(`cidrsubnet\(local\.network_ip_range,\s*(\d+)\s*-\s*tonumber`),
		constant: hetznerMaxNetworkPrefix,
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
		kind: cidrFloorDeferred,
		rel:  "infra/templates/project/aws/networking.tf",
		// Re-anchored by #1936. The carve still exists and is still derived from var.vpc_cidr — it
		// just runs through `local.vpc_cidr_for_subnet_plan` (line 88, `local.vpc_cidr_is_carvable ?
		// var.vpc_cidr : "10.0.0.0/16"`) now, because the plan moved into one declarative map so a
		// netnum cannot be edited without also moving the span the disjointness guard checks. The
		// old pattern named the literal `var.vpc_cidr` argument and so stopped matching, which fired
		// this test's "close it out" branch — correctly reporting drift, wrongly diagnosing it as
		// the carve disappearing. Anchored on the local, which is the expression that now carries it.
		pattern: regexp.MustCompile(`cidrsubnet\(local\.vpc_cidr_for_subnet_plan,`),
		why:     "the /18 Go-side floor is owned by #1942; #1936 has landed the template-side fail-closed guard (terraform_data.vpc_cidr_carvable_guard)",
	},
}

// TestNetworkCIDRFloorsMatchTemplates re-derives every network-CIDR floor from the cidrsubnet()
// expression that implies it, and pins the two clouds that deliberately have no rule — GCP
// because there is nothing to carve, AWS because the number is owned elsewhere. Both are
// asserted against the template, so neither can quietly stop being true.
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
				got := scrapeInt(t, src, coupling.rel, coupling.pattern)
				if got != coupling.constant {
					t.Errorf("%s: %s carves at `%d - <prefix>`, so the floor is /%d, but validate.go "+
						"encodes /%d", cloudName, coupling.rel, got, got, coupling.constant)
				}

			case cidrFloorFromFixedNewbits:
				newbits := scrapeInt(t, src, coupling.rel, coupling.pattern)
				if want := 32 - newbits; want != coupling.constant {
					t.Errorf("%s: %s carves at %d newbits, so the structural floor is /%d, but "+
						"validate.go encodes /%d", cloudName, coupling.rel, newbits, want, coupling.constant)
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
