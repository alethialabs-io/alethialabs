// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

// TestPlacementNamespace_RefusesEveryBYOReservedNamespace (#6551): a namespace placement is refused
// EVERY name in EVERY group of byo_reserved_namespaces.json — the one list, not a copy — and every
// reserved prefix, and each refusal names the namespace and gives a reason.
func TestPlacementNamespace_RefusesEveryBYOReservedNamespace(t *testing.T) {
	var list byoReservedNamespaceList
	if err := json.Unmarshal(byoReservedNamespacesJSON, &list); err != nil {
		t.Fatalf("byo_reserved_namespaces.json: %v", err)
	}
	total := 0
	for _, g := range list.Groups {
		for _, ns := range g.Namespaces {
			total++
			err := PlacementNamespaceError(ns, nil)
			if err == nil {
				t.Errorf("group %s: placement into %q accepted; it is reserved", g.ID, ns)
				continue
			}
			if !strings.Contains(err.Error(), `"`+ns+`"`) || !strings.Contains(err.Error(), "reserved") {
				t.Errorf("group %s: the refusal of %q must name it and say it is reserved, got: %v", g.ID, ns, err)
			}
		}
	}
	if total < 20 {
		t.Fatalf("only %d reserved names were exercised — the list did not load", total)
	}
	for _, p := range list.Prefixes {
		if PlacementNamespaceReason(p.Prefix+"x", nil) != p.Reason {
			t.Errorf("prefix %q must be refused with its own reason", p.Prefix)
		}
	}
}

// TestPlacementNamespace_RefusesTheNamesTheIssueNames asserts by NAME what #6551 lists, so a group
// reshuffle in the JSON cannot drop one silently: the host's application namespace ("default"), the
// ArgoCD namespace, kube-*, and the BYO database users namespace.
func TestPlacementNamespace_RefusesTheNamesTheIssueNames(t *testing.T) {
	for _, ns := range []string{"default", "argocd", "kube-system", "kube-public", "kube-node-lease", "kube-anything", manifests.ByoDBUsersNamespace, "alethia-system", "vcluster-dev"} {
		if PlacementNamespaceReason(ns, nil) == "" {
			t.Errorf("placement into %q must be refused", ns)
		}
	}
}

// TestPlacementNamespace_RefusesBYOChartNamespaces: the placement-only prefix. byo- is where the host's
// BYO charts deploy (ByoChartNamespace), so a placement is refused it — and a BYO chart is NOT, which
// is why it lives in placementPrefixes and not in prefixes.
func TestPlacementNamespace_RefusesBYOChartNamespaces(t *testing.T) {
	var list byoReservedNamespaceList
	if err := json.Unmarshal(byoReservedNamespacesJSON, &list); err != nil {
		t.Fatalf("byo_reserved_namespaces.json: %v", err)
	}
	found := false
	for _, p := range list.PlacementPrefixes {
		if p.Prefix == byoProjectPrefix {
			found = true
		}
	}
	if !found {
		t.Fatalf("placementPrefixes must carry %q, the prefix ByoChartNamespace derives every BYO chart namespace with", byoProjectPrefix)
	}
	for _, ns := range []string{ByoChartNamespace("payments"), ByoChartNamespace(strings.Repeat("a", 70)), "byo-e2e"} {
		if PlacementNamespaceReason(ns, nil) == "" {
			t.Errorf("placement into BYO chart namespace %q must be refused", ns)
		}
	}
	if err := validateByoNamespace("byo-e2e"); err != nil {
		t.Errorf("the placement-only prefix leaked into the BYO rule: %v", err)
	}
}

// TestPlacementNamespace_RefusesTheHostsOwnNamespaces: the dynamic half. A namespace one of the host
// environment's BYO charts chose is refused, with the host reason; the same name is accepted when the
// host does not use it.
func TestPlacementNamespace_RefusesTheHostsOwnNamespaces(t *testing.T) {
	host := []string{"payments", " ledger "}
	for _, ns := range []string{"payments", "ledger"} {
		if got := PlacementNamespaceReason(ns, host); got != PlacementHostNamespaceReason {
			t.Errorf("placement into the host's %q: reason %q, want the host reason", ns, got)
		}
	}
	if got := PlacementNamespaceReason("payments", nil); got != "" {
		t.Errorf("%q is not reserved when the host does not use it, got %q", "payments", got)
	}
}

// TestPlacementNamespace_AcceptsOrdinaryNamespaces — the refusal must not reach ordinary names,
// including the legacy Preview environment's "preview" and a preview's "preview-pr-42", which are
// namespace placements themselves, and names that merely contain a reserved word.
func TestPlacementNamespace_AcceptsOrdinaryNamespaces(t *testing.T) {
	for _, ns := range []string{"team-web", "preview", "preview-pr-42", "staging", "my-default", "argocd-apps", "kubernetes-dashboard", "byo", "mybyo-x"} {
		if err := PlacementNamespaceError(ns, []string{"payments"}); err != nil {
			t.Errorf("ordinary namespace %q refused: %v", ns, err)
		}
	}
}

// TestByoNewlyReserved_IsExactlyTheNamesOnlyTheNewGroupsReserve (#6551): the warn-not-refuse rule for
// an already-attached BYO chart covers exactly the names that ONLY the groups this issue added
// reserve. Every name an older group reserves keeps its refusal — "warn" never loosens a rule.
func TestByoNewlyReserved_IsExactlyTheNamesOnlyTheNewGroupsReserve(t *testing.T) {
	var list byoReservedNamespaceList
	if err := json.Unmarshal(byoReservedNamespacesJSON, &list); err != nil {
		t.Fatal(err)
	}
	older := map[string]bool{}
	var warnGroups []string
	for _, g := range list.Groups {
		if g.ByoAttached == "warn" {
			warnGroups = append(warnGroups, g.ID)
			continue
		}
		for _, n := range g.Namespaces {
			older[n] = true
		}
	}
	if strings.Join(warnGroups, ",") != "platformDataServices,platformCloudIdentities" {
		t.Fatalf("byoAttached warn is on %v; it is for exactly the two groups #6551 added", warnGroups)
	}
	want := map[string]bool{}
	for _, g := range list.Groups {
		if g.ByoAttached != "warn" {
			continue
		}
		for _, n := range g.Namespaces {
			if !older[n] {
				want[n] = true
			}
		}
	}
	for _, n := range []string{"caches", "cnpg-system", "databases", "nosql", "scylla-operator", "topics", "fluent-bit"} {
		if !want[n] {
			t.Errorf("%q should be newly reserved", n)
		}
	}
	if len(want) != 7 {
		t.Errorf("newly reserved = %v, want exactly the 7 names", want)
	}
	for n := range want {
		if ByoNewlyReservedNamespaceReason(n) == "" {
			t.Errorf("%q: no newly-reserved reason", n)
		}
		if err := validateByoNamespace(n); err != nil {
			t.Errorf("%q: an attached BYO chart there must be kept, not refused: %v", n, err)
		}
		if PlacementNamespaceReason(n, nil) == "" {
			t.Errorf("%q: a namespace placement must still be refused it", n)
		}
	}
	for n := range older {
		if ByoNewlyReservedNamespaceReason(n) != "" {
			t.Errorf("%q is reserved by an older group, so it must keep its refusal, not become warn-only", n)
		}
		if validateByoNamespace(n) == nil {
			t.Errorf("%q: previously refused for a BYO chart, must still be", n)
		}
	}
}
