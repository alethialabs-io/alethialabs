// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package validate

import (
	"net"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// The registries. A generated Step names a rule; this file is the ONLY place a name becomes
// behaviour. Nothing in a spec — committed or fetched — can add an entry here, which is what makes
// "nothing in a schema is ever executed" true rather than aspirational.
//
// Every entry is a rule the console evaluates as a `.refine()` / `.transform()` closure and this
// package evaluates independently. testdata/validation-cases.json holds the two to the same answers
// over named cases; conformance_test.go runs it. Adding a rule here without adding it to the
// generator's declaration table leaves it unreferenced — TestNoOrphanRuleImplementations says so.

var predicates = map[string]Predicate{
	// The apps-repo subpath grammar. The AUTHORITY is argocd.ValidateAppsPath, which is what
	// actually runs before the path is rendered into an ArgoCD Application — this rule delegates to
	// it rather than restating it, so there is no third copy of the grammar to keep in step.
	"apps_path": func(v string, _ *int) bool {
		return argocd.ValidateAppsPath(v) == nil
	},

	// The reserved platform tfvar namespace. Mirrors provisioner.byoReservedVarPrefix, which is
	// CASE-SENSITIVE: `strings.HasPrefix(k, "alethia_")`. A case-INSENSITIVE mirror here would
	// refuse `Alethia_project_id`, which the runner passes through as an ordinary customer
	// variable — the CLI would then reject input the server accepts.
	//
	// The runner's disposition is DROP-with-a-warning, not reject, which is why the generated step
	// carries SeverityWarn. The console form refuses the key outright, and may: a form exists to
	// tell a user that a value will not do what they think before it is stored.
	"not_reserved_tfvar_key": func(v string, _ *int) bool {
		return !strings.HasPrefix(v, reservedTfvarPrefix)
	},

	// The per-cloud network floor. Mirrors cloud.validateNetworkCIDR: the cloud's template carves
	// its subnets with cidrsubnet(), so a network narrower than the floor plans clean and dies
	// mid-apply. `arg` is that cloud's floor; with no argument the rule ABSTAINS rather than pick
	// one, because picking the tightest floor would refuse a /22 that Hetzner accepts.
	"network_cidr_max_prefix": func(v string, arg *int) bool {
		if arg == nil {
			return true
		}
		// An unset network is explicitly valid, not merely absent: validateNetworkCIDR's own first
		// line is `if cidr == "" { return nil }`, and every project that predates the field stores
		// exactly this. Both empty cases are in the conformance table.
		if v == "" {
			return true
		}
		_, ipnet, err := net.ParseCIDR(v)
		if err != nil || ipnet.IP.To4() == nil {
			return false
		}
		ones, _ := ipnet.Mask.Size()
		return ones <= *arg
	},
}

var transforms = map[string]Transform{
	// strings.TrimSpace — the unicode.IsSpace set. The console's `goTrimSpace` reproduces exactly
	// this set rather than calling String.prototype.trim(), because the two disagree at the edges:
	// JS trims U+FEFF and Go does not, Go trims U+0085 and JS does not. Both edges are named cases
	// in the conformance table.
	"go_trim_space": strings.TrimSpace,
}

// reservedTfvarPrefix is stated here rather than imported because provisioner.byoReservedVarPrefix
// is unexported. TestReservedTfvarPrefixMatchesTheProvisioner reads the provisioner's source and
// fails if the two ever part company, so this is a mirror that something checks — not a constant
// somebody has to remember.
const reservedTfvarPrefix = "alethia_"
