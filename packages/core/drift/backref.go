// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// This file is the ASSIGNMENT BACK-REFERENCE tier (ReasonAssignmentBackReference).
//
// The shape it exists for, measured on hetzner (#845, run 36667774857; and the plain floor
// soak of 2026-08-25, demos/proofs/hetzner/20260825T192100Z, with NO placements at all):
//
//	hcloud_primary_ip.*     assignee_id 0 -> <server id>, assignee_type "unassigned" -> "server"
//	hcloud_firewall.this    apply_to [] -> [{server = <id>}, ...] (one per server)
//
// The template attaches both from the OTHER side: `hcloud_server.public_net.ipv4 =
// hcloud_primary_ip.X.id` and `hcloud_server.firewall_ids = [hcloud_firewall.this.id]`. OpenTofu
// creates the primary IP and the firewall FIRST (the server depends on them), records them as
// unassigned, then creates the server, which performs the assignment. Nothing re-reads the primary
// IP or the firewall in that apply, so their recorded state is stale by construction, and the
// hcloud API reports the assignment back on both objects on every later Read. A refresh-only plan
// never writes state, so the difference is permanent for every hetzner Fabric until something
// happens to run a second apply.
//
// It cannot be fixed in the template: the attributes are Optional+Computed, and `ignore_changes`
// governs planned changes, not the refresh deltas `resource_drift` is made of. Declaring the
// assignment on the primary IP instead is a dependency cycle (the server needs the IP's address
// for the Talos cert SANs before it exists).
//
// WHY THIS CANNOT HIDE A REAL CHANGE. The dismissal is not "these attribute names are noisy". It
// fires only when the delta is PROVEN to be the reverse edge of an assignment another managed
// resource in the SAME state already declares, and it proves that twice:
//
//   - The before side must be UNASSIGNED (assignee_id null/0; apply_to elements only ever ADDED,
//     none removed or altered). A re-assignment from one server to another, a detach, or an
//     altered label selector never qualifies.
//   - Every server the after side names must be a MANAGED hcloud_server of the SAME provider whose
//     forward edge (public_net[*].ipv4|ipv6 == this IP's id; firewall_ids ∋ this firewall's id)
//     holds in BOTH the recorded state (what the last apply wrote — the configured intent) AND the
//     refreshed state (live). A server that is not in state — an attacker's box — can never be
//     named by a dismissed delta. A forward edge added out-of-band to a managed server does not
//     qualify either, because it is absent from that server's recorded state, and the server's own
//     drift would be reported regardless.
//
// So a dismissed delta says exactly one thing: "the cloud reports, on the target, the assignment
// the configuration made from the owner, and the owner still holds it". That is the same fact
// recorded twice, not a divergence from intent.
//
// Fail-closed like every other tier: no prior_state in the plan, an owner absent from either view,
// an id that is not a plain integer, a provider that is not hetznercloud/hcloud, or any value shape
// this does not recognise — and the rule does not fire, so the delta stays drift.
//
// The same tier has two more providers, whose shapes are different enough to live in their own
// files: hashicorp/aws (awsbackref.go), where the reverse edge is written by a separate ATTACHMENT
// resource (a policy attachment, a security-group rule, a route, a NAT gateway) rather than by a
// server; and hashicorp/google (gcpbackref.go), where a GKE cluster reports the node pools separate
// google_container_node_pool resources attached to it.

// stateObject is one resource instance as a state view holds it.
type stateObject struct {
	mode     tfjson.ResourceMode
	typ      string
	provider string
	// module is the module instance address the resource lives in ("" for the root module,
	// "module.eks[0].module.eks" for a nested one). The aws tier (awsbackref.go) only accepts
	// a sibling from the SAME module instance as the resource it vouches for.
	module string
	values map[string]any
}

// stateIndex holds the two views of state a back-reference must agree with.
type stateIndex struct {
	// refreshed is the plan's prior_state: in a refresh-only plan, the state AFTER refresh —
	// what the cloud reports now.
	refreshed map[string]stateObject
	// recorded is what the previous apply wrote: the refreshed view with every drifted
	// resource replaced by its resource_drift BEFORE value. A resource absent from
	// resource_drift is, by OpenTofu's own comparison, identical in both.
	recorded map[string]stateObject
}

// indexState builds both state views from a refresh-only plan. Returns nil when the plan
// carries no prior_state, which the back-reference tier treats as "no evidence" and never
// fires on.
func indexState(plan *tfjson.Plan) *stateIndex {
	if plan == nil || plan.PriorState == nil || plan.PriorState.Values == nil || plan.PriorState.Values.RootModule == nil {
		return nil
	}
	idx := &stateIndex{refreshed: map[string]stateObject{}, recorded: map[string]stateObject{}}
	var walk func(m *tfjson.StateModule)
	walk = func(m *tfjson.StateModule) {
		if m == nil {
			return
		}
		for _, r := range m.Resources {
			if r == nil || r.Address == "" {
				continue
			}
			obj := stateObject{mode: r.Mode, typ: r.Type, provider: r.ProviderName, module: m.Address, values: r.AttributeValues}
			idx.refreshed[r.Address] = obj
			idx.recorded[r.Address] = obj
		}
		for _, c := range m.ChildModules {
			walk(c)
		}
	}
	walk(plan.PriorState.Values.RootModule)

	for _, rc := range plan.ResourceDrift {
		if rc == nil || rc.Change == nil || rc.Mode != tfjson.ManagedResourceMode {
			continue
		}
		before, ok := rc.Change.Before.(map[string]any)
		if !ok {
			// No readable recorded value: the recorded view must not fall back to the
			// refreshed one, or a changed owner would vouch for itself.
			delete(idx.recorded, rc.Address)
			continue
		}
		idx.recorded[rc.Address] = stateObject{
			mode: tfjson.ManagedResourceMode, typ: rc.Type, provider: rc.ProviderName, module: rc.ModuleAddress, values: before,
		}
	}
	return idx
}

// hcloudProviderSuffix identifies the Hetzner Cloud provider under either registry host.
const hcloudProviderSuffix = "/hetznercloud/hcloud"

// backReferenceRoots returns the top-level attributes of rc whose ENTIRE delta is a verified
// assignment back-reference, or nil. Only the attributes returned here may be dismissed on
// this tier, and only when examine finds every other differing leaf dismissible too.
func backReferenceRoots(rc *tfjson.ResourceChange, before, after map[string]any, st *stateIndex) map[string]struct{} {
	if st == nil {
		return nil
	}
	var roots []string
	switch {
	case strings.HasSuffix(rc.ProviderName, hcloudProviderSuffix):
		switch rc.Type {
		case "hcloud_primary_ip":
			roots = hcloudPrimaryIPAssignment(rc.ProviderName, before, after, st)
		case "hcloud_firewall":
			roots = hcloudFirewallApplyTo(rc.ProviderName, before, after, st)
		}
	case strings.HasSuffix(rc.ProviderName, awsProviderSuffix):
		roots = awsBackReferenceRoots(rc, before, after, st)
	case strings.HasSuffix(rc.ProviderName, googleProviderSuffix):
		roots = gcpBackReferenceRoots(rc, before, after, st)
	}
	if len(roots) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(roots))
	for _, r := range roots {
		out[r] = struct{}{}
	}
	return out
}

// hcloudPrimaryIPAssignment verifies an unassigned -> assigned-to-a-managed-server delta on
// a primary IP. Returns the attributes it covers, or nil.
func hcloudPrimaryIPAssignment(provider string, before, after map[string]any, st *stateIndex) []string {
	pipID, ok := sameID(before, after)
	if !ok {
		return nil
	}
	// The IP family selects which forward edge on the server must point back at it.
	family, _ := after["type"].(string)
	if bf, _ := before["type"].(string); bf != family {
		return nil
	}
	var edge string
	switch family {
	case "ipv4":
		edge = "ipv4"
	case "ipv6":
		edge = "ipv6"
	default:
		return nil
	}
	// Before: unassigned. Older provider versions recorded assignee_type "server" even on an
	// unassigned IP (it was Required, defaulting to "server"), so the unassigned evidence is
	// assignee_id alone; assignee_type may only be one of the unassigned encodings or "server".
	if !unassignedID(before["assignee_id"]) {
		return nil
	}
	switch before["assignee_type"] {
	case nil, "", "unassigned", "server":
	default:
		return nil
	}
	if t, _ := after["assignee_type"].(string); t != "server" {
		return nil
	}
	serverID, ok := plainID(after["assignee_id"])
	if !ok {
		return nil
	}
	holds := func(server map[string]any) bool {
		for _, pn := range asList(server["public_net"]) {
			m, ok := pn.(map[string]any)
			if !ok {
				continue
			}
			if id, ok := plainID(m[edge]); ok && id == pipID {
				return true
			}
		}
		return false
	}
	if !st.managedServerHolds(provider, serverID, holds) {
		return nil
	}
	return []string{"assignee_id", "assignee_type"}
}

// hcloudFirewallApplyTo verifies that a firewall's apply_to only GAINED server entries, each
// one a managed server whose firewall_ids names this firewall. Returns ["apply_to"] or nil.
func hcloudFirewallApplyTo(provider string, before, after map[string]any, st *stateIndex) []string {
	fwID, ok := sameID(before, after)
	if !ok {
		return nil
	}
	var prior []any
	switch v := before["apply_to"].(type) {
	case nil:
	case []any:
		prior = v
	default:
		return nil
	}
	now, ok := after["apply_to"].([]any)
	if !ok {
		return nil
	}
	// Nothing recorded may have been removed or altered: every prior element survives verbatim.
	for _, p := range prior {
		if !containsDeep(now, p) {
			return nil
		}
	}
	holds := func(server map[string]any) bool {
		for _, f := range asList(server["firewall_ids"]) {
			if id, ok := plainID(f); ok && id == fwID {
				return true
			}
		}
		return false
	}
	added := 0
	for _, e := range now {
		if containsDeep(prior, e) {
			continue
		}
		m, ok := e.(map[string]any)
		if !ok {
			return nil
		}
		// Only a SERVER entry is a back-reference. A label selector is an assignment made ON
		// the firewall, so one appearing out-of-band is exactly the change to surface.
		for k, v := range m {
			switch k {
			case "server":
			case "label_selector":
				if v != nil && v != "" {
					return nil
				}
			default:
				return nil
			}
		}
		serverID, ok := plainID(m["server"])
		if !ok || !st.managedServerHolds(provider, serverID, holds) {
			return nil
		}
		added++
	}
	if added == 0 {
		return nil
	}
	return []string{"apply_to"}
}

// managedServerHolds reports whether a managed hcloud_server of the same provider with id
// serverID exists in BOTH the recorded and the refreshed state, and holds satisfies both.
func (st *stateIndex) managedServerHolds(provider, serverID string, holds func(map[string]any) bool) bool {
	addrs := make([]string, 0, len(st.refreshed))
	for a := range st.refreshed {
		addrs = append(addrs, a)
	}
	sort.Strings(addrs)
	for _, a := range addrs {
		live := st.refreshed[a]
		if !isManagedServer(live, provider) {
			continue
		}
		if id, ok := plainID(live.values["id"]); !ok || id != serverID {
			continue
		}
		rec, ok := st.recorded[a]
		if !ok || !isManagedServer(rec, provider) {
			return false
		}
		if id, ok := plainID(rec.values["id"]); !ok || id != serverID {
			return false
		}
		return holds(rec.values) && holds(live.values)
	}
	return false
}

// isManagedServer reports whether obj is a managed hcloud_server of exactly this provider.
func isManagedServer(obj stateObject, provider string) bool {
	return obj.mode == tfjson.ManagedResourceMode && obj.typ == "hcloud_server" && obj.provider == provider && obj.values != nil
}

// sameID returns the object's id when it is a plain integer id identical on both sides.
func sameID(before, after map[string]any) (string, bool) {
	b, okB := plainID(before["id"])
	a, okA := plainID(after["id"])
	if !okB || !okA || a != b {
		return "", false
	}
	return a, true
}

// maxExactInt is 2^53: every integer below it has an exact float64 representation, so two
// distinct ids below it can never decode to the same float64.
const maxExactInt = 1 << 53

// plainID canonicalises an hcloud id — a positive integer carried as a JSON string or number
// — to its decimal string. Anything else (zero, negative, fractional, ≥2^53, non-digit text)
// is not an id this tier will compare, so it reports false and the rule does not fire.
func plainID(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		n, err := strconv.ParseUint(t, 10, 64)
		if err != nil || n == 0 || n >= maxExactInt {
			return "", false
		}
		return strconv.FormatUint(n, 10), true
	case float64:
		if t <= 0 || t >= maxExactInt || t != math.Trunc(t) {
			return "", false
		}
		return strconv.FormatUint(uint64(t), 10), true
	default:
		// json.Number and friends: go through their string form, which the string branch
		// already validates.
		if s, ok := v.(interface{ String() string }); ok {
			return plainID(s.String())
		}
		return "", false
	}
}

// unassignedID reports whether v is one of the encodings of "no assignee": null or 0.
func unassignedID(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case float64:
		return t == 0
	case string:
		return t == "" || t == "0"
	default:
		if s, ok := v.(interface{ String() string }); ok {
			return s.String() == "0"
		}
		return false
	}
}

// asList returns v as a list, or nil when it is not one.
func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

// containsDeep reports whether list holds an element deeply equal to v.
func containsDeep(list []any, v any) bool {
	for _, e := range list {
		if reflect.DeepEqual(e, v) {
			return true
		}
	}
	return false
}
