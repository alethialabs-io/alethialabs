// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package nodekeys

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
)

// The OpenTofu validations cannot import this package, so they carry its regexes as literals. This
// test is what makes the Go definition the ONE definition: it parses each template variable that
// validates a node label or taint key, collects every regex() literal in its validation blocks, and
// fails when one of the key rules is missing or when a literal that is SHAPED like a key rule is not
// exactly this package's.
//
// Boundary: it reads regex() literals only. A validation that tests a key without regex() (a
// startswith(), say) is invisible to it; the reference contract and the Karpenter knobs use regex()
// for every key rule today, and each template's tofu test proves the rule refuses what it should.

// keyRuleSites are the variables whose validations carry the key rules, by file relative to the repo
// root. Each must carry the key grammar, the value grammar and the reserved-domain regex.
var keyRuleSites = map[string][]string{
	"infra/templates/project/aws/variables.tf": {
		"karpenter_node_labels", "karpenter_node_taints",
	},
	"packages/core/cloud/testdata/nodepool/reference/variables.tf": {
		"node_labels", "node_taints", "extra_node_pools",
	},
}

// repoRoot is the repository root, three directories above this package.
func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(wd, "..", "..", "..")
}

// regexLiterals returns, per variable, every literal first argument of a regex() call inside its
// validation blocks.
func regexLiterals(t *testing.T, path string) map[string][]string {
	t.Helper()
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	f, diags := hclsyntax.ParseConfig(src, path, hcl.InitialPos)
	if diags.HasErrors() {
		t.Fatalf("%s: %s", path, diags.Error())
	}
	body, ok := f.Body.(*hclsyntax.Body)
	if !ok {
		t.Fatalf("%s: not native HCL syntax", path)
	}
	out := map[string][]string{}
	for _, blk := range body.Blocks {
		if blk.Type != "variable" || len(blk.Labels) != 1 {
			continue
		}
		name := blk.Labels[0]
		for _, vb := range blk.Body.Blocks {
			if vb.Type != "validation" {
				continue
			}
			hclsyntax.VisitAll(vb.Body, func(n hclsyntax.Node) hcl.Diagnostics {
				call, ok := n.(*hclsyntax.FunctionCallExpr)
				if !ok || call.Name != "regex" || len(call.Args) == 0 {
					return nil
				}
				v, d := call.Args[0].Value(nil)
				if d.HasErrors() || v.Type() != cty.String {
					t.Errorf("%s: variable %q passes regex() a pattern that is not a string literal; the drift test cannot read it", path, name)
					return nil
				}
				out[name] = append(out[name], v.AsString())
				return nil
			})
		}
	}
	return out
}

// TestKeyRuleLiteralsMatchTheGoDefinition holds every template copy of the key rules to this package.
func TestKeyRuleLiteralsMatchTheGoDefinition(t *testing.T) {
	root := repoRoot(t)
	files := make([]string, 0, len(keyRuleSites))
	for f := range keyRuleSites {
		files = append(files, f)
	}
	sort.Strings(files)
	for _, rel := range files {
		lits := regexLiterals(t, filepath.Join(root, filepath.FromSlash(rel)))
		for _, name := range keyRuleSites[rel] {
			got := lits[name]
			if len(got) == 0 {
				t.Errorf("%s: variable %q has no regex() in its validations (renamed or moved? update keyRuleSites)", rel, name)
				continue
			}
			for _, want := range []string{QualifiedKeyRegex, ValueRegex, ReservedDomainRegex} {
				if !contains(got, want) {
					t.Errorf("%s: variable %q does not carry nodekeys' rule %q. Copy it exactly; a hand-edited copy is how the rule drifts", rel, name, want)
				}
			}
			for _, lit := range got {
				switch {
				case strings.Contains(lit, `kubernetes\.io`) && lit != ReservedDomainRegex && lit != NodeRestrictionDomainRegex:
					t.Errorf("%s: variable %q carries a reserved-domain regex that is not nodekeys.ReservedDomainRegex:\n  got  %s\n  want %s", rel, name, lit, ReservedDomainRegex)
				case strings.Contains(lit, `[-A-Za-z0-9_.]`) && lit != QualifiedKeyRegex && lit != ValueRegex:
					t.Errorf("%s: variable %q carries a key or value grammar that is not nodekeys': %s", rel, name, lit)
				}
			}
		}
	}
}

// TestKeyRuleSitesAreEnumeratedFromTheTemplates fails when a template validates a label or taint key
// in a variable keyRuleSites does not name: a site the drift test does not know about is a copy that
// can drift unseen. It scans every project template's variables.tf for the reserved-domain shape.
func TestKeyRuleSitesAreEnumeratedFromTheTemplates(t *testing.T) {
	root := repoRoot(t)
	paths, err := filepath.Glob(filepath.Join(root, "infra", "templates", "project", "*", "variables.tf"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("found no project template variables.tf (err=%v): the scan would pass on nothing", err)
	}
	for _, p := range paths {
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		known := map[string]bool{}
		for _, n := range keyRuleSites[rel] {
			known[n] = true
		}
		for name, lits := range regexLiterals(t, p) {
			for _, lit := range lits {
				if strings.Contains(lit, `kubernetes\.io`) && !known[name] {
					t.Errorf("%s: variable %q validates a reserved key domain but is not in keyRuleSites, so its copy of the rule is not held to nodekeys", rel, name)
				}
			}
		}
	}
}

// contains reports whether list has s.
func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
