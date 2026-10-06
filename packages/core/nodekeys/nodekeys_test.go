// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package nodekeys

import (
	"strings"
	"testing"
)

// TestValidKey pins the grammar and Kubernetes' lengths, and which keys the portable 63-character
// whole-key cap (the contract's tofu length check) additionally refuses.
func TestValidKey(t *testing.T) {
	cases := []struct {
		key             string
		valid, portable bool
	}{
		{"team", true, true},
		{"example.com/team", true, true},
		{"a.b-c.example.com/x_y.z", true, true},
		{strings.Repeat("a", 63), true, true},
		{"example.com/" + strings.Repeat("a", 51), true, true},  // 63 whole
		{"example.com/" + strings.Repeat("a", 52), true, false}, // 64 whole: Kubernetes yes, EKS no
		{strings.Repeat("a", 64), false, false},
		{strings.Repeat("a", 64) + ".com/x", false, false},                        // a DNS label over 63
		{strings.Repeat(strings.Repeat("a", 50)+".", 5) + "aaaa/x", false, false}, // prefix over 253
		{"", false, false},
		{"-team", false, false},
		{"team-", false, false},
		{"Example.com/x", false, false},
		{"example.com/", false, false},
		{"bad key", false, false},
	}
	for _, c := range cases {
		if got := ValidKey(c.key); got != c.valid {
			t.Errorf("ValidKey(%q) = %v, want %v", c.key, got, c.valid)
		}
		if got := c.valid && len(c.key) <= PortableKeyMaxLength; got != c.portable {
			t.Errorf("%q within the portable bound = %v, want %v", c.key, got, c.portable)
		}
	}
}

// TestValidValue pins the value grammar and its 63-character cap; empty is a valid Kubernetes value.
func TestValidValue(t *testing.T) {
	for v, want := range map[string]bool{
		"":                      true,
		"batch":                 true,
		"a.b_c-d":               true,
		strings.Repeat("v", 63): true,
		strings.Repeat("v", 64): false,
		"pay ments":             false,
		"-x":                    false,
		"x.":                    false,
	} {
		if got := ValidValue(v); got != want {
			t.Errorf("ValidValue(%q) = %v, want %v", v, got, want)
		}
	}
}

// TestReservedDomain pins every reserved domain, the absent dot boundary, and that a domain merely
// CONTAINING a reserved one is the user's.
func TestReservedDomain(t *testing.T) {
	for _, d := range ReservedDomains {
		if _, r := ReservedDomain(d + "/x"); !r {
			t.Errorf("%s/x is not reserved", d)
		}
		if _, r := ReservedDomain("sub." + d + "/x"); !r {
			t.Errorf("sub.%s/x is not reserved", d)
		}
	}
	for key, want := range map[string]bool{
		"examplekubernetes.io/x":           true, // no dot boundary, as Karpenter's CRD
		"examplealethia.io/x":              true,
		"kubernetes.io.example.com/x":      false,
		"example.com/kubernetes.io":        false, // the NAME is not a domain
		"team":                             false,
		"node-restriction.kubernetes.io/x": true,
	} {
		if _, got := ReservedDomain(key); got != want {
			t.Errorf("ReservedDomain(%q) reserved = %v, want %v", key, got, want)
		}
	}
	if d, _ := ReservedDomain("alethia.io/pool"); d != "alethia.io" {
		t.Errorf("ReservedDomain returned domain %q", d)
	}
}

// TestIsNodeRestrictionDomain pins the Karpenter-only exception: the subdomain and its children, and
// nothing else in kubernetes.io.
func TestIsNodeRestrictionDomain(t *testing.T) {
	for d, want := range map[string]bool{
		"node-restriction.kubernetes.io":   true,
		"a.node-restriction.kubernetes.io": true,
		"node-role.kubernetes.io":          false,
		"xnode-restriction.kubernetes.io":  false,
		"kubernetes.io":                    false,
	} {
		if got := IsNodeRestrictionDomain(d); got != want {
			t.Errorf("IsNodeRestrictionDomain(%q) = %v, want %v", d, got, want)
		}
	}
}

// TestReservedDomainRegexAndText pins the rendered regex the templates copy, and the message list.
func TestReservedDomainRegexAndText(t *testing.T) {
	want := `(kubernetes\.io|k8s\.io|karpenter\.sh|karpenter\.k8s\.aws|amazonaws\.com|cloud\.google\.com|gke\.io|azure\.com|hetzner\.cloud|alethia\.io)$`
	if ReservedDomainRegex != want {
		t.Errorf("ReservedDomainRegex = %s, want %s", ReservedDomainRegex, want)
	}
	if got := ReservedDomainsText(); !strings.HasPrefix(got, "kubernetes.io, k8s.io, ") || !strings.HasSuffix(got, "hetzner.cloud or alethia.io") {
		t.Errorf("ReservedDomainsText() = %q", got)
	}
	if keyPrefix("team") != "" || keyPrefix("a.b/c") != "a.b" {
		t.Error("keyPrefix")
	}
}
