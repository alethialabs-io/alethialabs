// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package nodekeys

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
)

// The OpenTofu validations cannot import this package, so they carry its regexes as literals. This
// test is what makes the Go definition the ONE definition. It parses each template variable that
// validates a node label or taint key, and classifies EVERY regex() call in its validation blocks by
// what the regex is applied to: a key (`k`, `t.key`), a value (`v`, `t.value`), a key's domain
// (`split("/", …)[0]`), a pool name (`p.name`) or an instance type (`p.instance_type`). Each literal is
// then compared, one by one, to the Go definition for its role. A variable that carries two copies of
// a rule (extra_node_pools checks both its labels and its taints) has each copy checked separately, and
// a regex applied to anything the test cannot classify fails rather than being skipped.
//
// For the cross-cloud contract it also reads the LENGTH bounds: every key regex must sit beside
// `length(<key>) <= PortableKeyMaxLength`, and every value regex beside `length(<value>) >= 1` and
// `length(<value>) <= ValueMaxLength`. The Karpenter knobs keep Kubernetes' own lengths (see the
// package doc), which their tofu test pins.
//
// Boundary: it reads regex() and length() comparisons only. A key rule written some other way (a
// startswith(), say) is invisible to it; both sites use regex() for every key rule today, and each
// template's tofu test proves the rule refuses what it should.

// keyRuleSite is one template file and the variables in it that carry the key rules.
type keyRuleSite struct {
	vars []string
	// portable sites follow the cross-cloud contract's lengths (PortableKeyMaxLength, non-empty values).
	portable bool
	// nodeRestriction names the variables allowed to carry NodeRestrictionDomainRegex: only the
	// Karpenter labels, which reach the API rather than the kubelet.
	nodeRestriction map[string]bool
}

// keyRuleSites are the variables whose validations carry the key rules, by file relative to the repo
// root.
var keyRuleSites = map[string]keyRuleSite{
	"infra/templates/project/aws/variables.tf": {
		vars:            []string{"karpenter_node_labels", "karpenter_node_taints"},
		nodeRestriction: map[string]bool{"karpenter_node_labels": true},
	},
	"packages/core/cloud/testdata/nodepool/reference/variables.tf": {
		vars:     []string{"node_labels", "node_taints", "extra_node_pools"},
		portable: true,
	},
}

// contractOnlyLiterals are the regexes the contract applies to things that are not node keys. They
// are the contract's, not this package's, and are listed so that every literal has a known owner.
var contractOnlyLiterals = map[string][]string{
	"poolname": {`^[a-z][a-z0-9]{0,11}$`, `^pool[0-9]+$`},
	"instance": {`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`},
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

// ruleUse is one regex() or length() comparison found in a validation, classified by role.
type ruleUse struct {
	role    string // key, value, domain, poolname, instance, or the unclassified expression
	literal string // the regex, or for a length check the operator and bound ("<= 63")
}

// operandRole names what an expression is, as the key rules see it.
func operandRole(e hclsyntax.Expression) string {
	switch x := e.(type) {
	case *hclsyntax.ScopeTraversalExpr:
		var parts []string
		for _, step := range x.Traversal {
			switch s := step.(type) {
			case hcl.TraverseRoot:
				parts = append(parts, s.Name)
			case hcl.TraverseAttr:
				parts = append(parts, s.Name)
			}
		}
		switch strings.Join(parts, ".") {
		case "k", "t.key":
			return "key"
		case "v", "t.value":
			return "value"
		case "p.name":
			return "poolname"
		case "p.instance_type":
			return "instance"
		}
		return "unclassified:" + strings.Join(parts, ".")
	case *hclsyntax.IndexExpr:
		if call, ok := x.Collection.(*hclsyntax.FunctionCallExpr); ok && call.Name == "split" {
			return "domain"
		}
	case *hclsyntax.RelativeTraversalExpr: // split("/", k)[0] parses as a traversal of a call
		if call, ok := x.Source.(*hclsyntax.FunctionCallExpr); ok && call.Name == "split" {
			return "domain"
		}
	}
	return "unclassified expression"
}

// ruleUses returns, per variable, every regex() call and every length() comparison in its
// validation blocks.
func ruleUses(t *testing.T, path string) (regexes, lengths map[string][]ruleUse) {
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
	regexes, lengths = map[string][]ruleUse{}, map[string][]ruleUse{}
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
				if call, ok := n.(*hclsyntax.FunctionCallExpr); ok && call.Name == "regex" && len(call.Args) == 2 {
					v, d := call.Args[0].Value(nil)
					if d.HasErrors() || v.Type() != cty.String {
						t.Errorf("%s: variable %q passes regex() a pattern that is not a string literal; the drift test cannot read it", path, name)
						return nil
					}
					regexes[name] = append(regexes[name], ruleUse{role: operandRole(call.Args[1]), literal: v.AsString()})
				}
				if op, ok := n.(*hclsyntax.BinaryOpExpr); ok {
					call, isCall := op.LHS.(*hclsyntax.FunctionCallExpr)
					if !isCall || call.Name != "length" || len(call.Args) != 1 {
						return nil
					}
					bound, d := op.RHS.Value(nil)
					if d.HasErrors() || bound.Type() != cty.Number {
						return nil
					}
					sym := map[*hclsyntax.Operation]string{hclsyntax.OpLessThanOrEqual: "<=", hclsyntax.OpGreaterThanOrEqual: ">="}[op.Op]
					if sym == "" {
						return nil
					}
					lengths[name] = append(lengths[name], ruleUse{role: operandRole(call.Args[0]), literal: sym + " " + bound.AsBigFloat().Text('f', -1)})
				}
				return nil
			})
		}
	}
	return regexes, lengths
}

// TestKeyRuleLiteralsMatchTheGoDefinition holds every template copy of the key rules to this package,
// literal by literal.
func TestKeyRuleLiteralsMatchTheGoDefinition(t *testing.T) {
	root := repoRoot(t)
	files := make([]string, 0, len(keyRuleSites))
	for f := range keyRuleSites {
		files = append(files, f)
	}
	sort.Strings(files)
	for _, rel := range files {
		site := keyRuleSites[rel]
		regexes, lengths := ruleUses(t, filepath.Join(root, filepath.FromSlash(rel)))
		for _, name := range site.vars {
			uses := regexes[name]
			if len(uses) == 0 {
				t.Errorf("%s: variable %q has no regex() in its validations (renamed or moved? update keyRuleSites)", rel, name)
				continue
			}
			count := map[string]int{}
			for i, u := range uses {
				count[u.role]++
				where := func() string {
					return rel + ": variable " + strconv.Quote(name) + ", regex #" + strconv.Itoa(i+1) + " (applied to a " + u.role + ")"
				}
				switch u.role {
				case "key":
					if u.literal != QualifiedKeyRegex {
						t.Errorf("%s is %s, nodekeys.QualifiedKeyRegex is %s", where(), u.literal, QualifiedKeyRegex)
					}
				case "value":
					if u.literal != ValueRegex {
						t.Errorf("%s is %s, nodekeys.ValueRegex is %s", where(), u.literal, ValueRegex)
					}
				case "domain":
					ok := u.literal == ReservedDomainRegex || (site.nodeRestriction[name] && u.literal == NodeRestrictionDomainRegex)
					if !ok {
						t.Errorf("%s is %s, nodekeys.ReservedDomainRegex is %s", where(), u.literal, ReservedDomainRegex)
					}
					if u.literal == ReservedDomainRegex {
						count["reserved"]++
					}
				case "poolname", "instance":
					if !site.portable || !contains(contractOnlyLiterals[u.role], u.literal) {
						t.Errorf("%s is %s, which is not one of the contract's %s rules %v", where(), u.literal, u.role, contractOnlyLiterals[u.role])
					}
				default:
					t.Errorf("%s: the drift test cannot tell what this regex checks, so it cannot hold it to nodekeys: %s", where(), u.literal)
				}
			}
			if count["key"] == 0 || count["value"] == 0 || count["reserved"] == 0 {
				t.Errorf("%s: variable %q must check keys, values and reserved domains; found %d key, %d value and %d reserved-domain regexes", rel, name, count["key"], count["value"], count["reserved"])
			}
			if count["reserved"] != count["key"] {
				t.Errorf("%s: variable %q checks %d keys but refuses reserved domains for %d of them", rel, name, count["key"], count["reserved"])
			}
			if !site.portable {
				continue
			}
			want := map[string]int{
				"key <= " + strconv.Itoa(PortableKeyMaxLength): count["key"],
				"value <= " + strconv.Itoa(ValueMaxLength):     count["value"],
				"value >= 1": count["value"],
			}
			got := map[string]int{}
			for _, l := range lengths[name] {
				if l.role == "key" || l.role == "value" {
					got[l.role+" "+l.literal]++
				}
			}
			for k, n := range want {
				if got[k] != n {
					t.Errorf("%s: variable %q has %d length checks %q, want one beside each of its %d %s regexes", rel, name, got[k], "length("+k+")", n, strings.Fields(k)[0])
				}
			}
			for k, n := range got {
				if _, ok := want[k]; !ok {
					t.Errorf("%s: variable %q has %d length checks %q that the contract does not define", rel, name, n, "length("+k+")")
				}
			}
		}
	}
}

// TestKeyRuleSitesAreEnumeratedFromTheTemplates fails when a template validates a label or taint key
// in a variable keyRuleSites does not name: a site the drift test does not know about is a copy that
// can drift unseen. It scans every project template's variables.tf for a regex applied to a key's
// domain.
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
		for _, n := range keyRuleSites[rel].vars {
			known[n] = true
		}
		regexes, _ := ruleUses(t, p)
		for name, uses := range regexes {
			for _, u := range uses {
				if (u.role == "domain" || strings.Contains(u.literal, `kubernetes\.io`)) && !known[name] {
					t.Errorf("%s: variable %q validates a key domain but is not in keyRuleSites, so its copy of the rule is not held to nodekeys", rel, name)
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
