// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"reflect"
	"sort"

	tfjson "github.com/hashicorp/terraform-json"
)

// This file is the hashicorp/google half of the ASSIGNMENT BACK-REFERENCE tier
// (ReasonAssignmentBackReference).
//
// The shape it exists for, measured on #845 run 36740452010 (gcp, dimension=floor,
// fabric_demo=true, attempt 2 — every tier converged and the vcluster tier proved, then the drift
// re-prove read in_sync=false drifted=1 normalized=8):
//
//	module.gke[0].google_container_cluster.cluster
//	    node_pool    []  -> [the pool google_container_node_pool.default[0] created]
//	    node_config  []  -> [that pool's node_config]
//
// The gke module (infra/templates/project/gcp/modules/gke/main.tf) creates the cluster with
// `remove_default_node_pool = true` and manages its one pool as a SEPARATE
// google_container_node_pool whose `cluster` names it. OpenTofu creates the cluster first; the
// provider deletes the default pool before the create's final Read, so the cluster is recorded with
// no pool and no node config. Then the pool is created, and nothing re-reads the cluster in that
// apply. On every later refresh the cluster's Read reports every pool the API lists
// (flattenClusterNodePools over cluster.NodePools, hashicorp/google 6.50.0) and the cluster-level
// node config, which the GKE API documents as "populated with the node configuration of the first
// node pool" for responses. A refresh-only plan never writes state, so every GCP Standard
// environment read out of sync on day zero, permanently.
//
// ignore_changes cannot fix it: it governs planned changes, not the refresh deltas resource_drift is
// made of (the same finding as for the hcloud and aws shapes; see backref.go, awsbackref.go). Inline
// `node_pool` blocks on the cluster are the pattern the provider documents as conflicting with
// google_container_node_pool, and would make every pool change a cluster change.
//
// WHY THIS CANNOT HIDE A REAL CHANGE. As for hcloud and aws, the dismissal is not "these attribute
// names are noisy". It proves that the cluster reports, and only reports, pools the SAME state
// manages, as those pools read themselves in the same refresh:
//
//   - node_pool: nothing recorded may be lost or altered (every recorded element survives
//     verbatim), at least one element is gained, element names are distinct, and every gained element
//     is a managed google_container_node_pool of the same provider, in the SAME module instance,
//     present in BOTH the recorded state (the last apply) and the refreshed state (live), whose
//     `cluster` is this cluster's name or id, whose project and location are this cluster's, and
//     whose name is the element's. And the element must MIRROR that pool's refreshed value field for
//     field (null and an empty collection read as the same, as empty_collection already argues) —
//     so an element carrying anything the pool resource does not itself report is not dismissed.
//     A pool created out of band (gcloud, the console, an attacker) is in no state, so it stays
//     drift; so does a pool whose own resource was removed from state.
//   - node_config: the recorded value must be EMPTY (null or []), and `remove_default_node_pool`
//     must be true in both views — that is what explains the empty record. The refreshed value must
//     mirror the node_config of the cluster's FIRST refreshed node_pool element, which must itself
//     pass every node_pool check above. A recorded node_config that changed, a node config
//     matching no managed pool, or a cluster that kept its default pool stays drift.
//
// The pool resource is refreshed in the SAME plan, and its own deltas are judged on their own. So
// an out-of-band change to the pool — a label, a machine type, an autoscaling bound — is reported on
// google_container_node_pool itself; the cluster mirroring it is the same fact recorded twice, not a
// second, hidden one.
//
// Known limits, each failing CLOSED (the cluster stays drift): configured taints (the provider's
// flatten keeps only the taints the PRIOR node config declared, and the cluster's prior is empty,
// so the two reads differ); an autoscaler resize landing between the cluster's and the pool's
// instance-group reads (node_count differs); the google-beta provider (not recognised); Autopilot
// (no google_container_node_pool exists, so nothing vouches).

// googleProviderSuffix identifies the Google provider under either registry host. google-beta is a
// different provider address and is deliberately not matched.
const googleProviderSuffix = "/hashicorp/google"

// gcpBackReferenceRoots dispatches a google resource to the one rule that knows its type, and
// returns the top-level attributes whose whole delta that rule verified, or nil.
func gcpBackReferenceRoots(rc *tfjson.ResourceChange, before, after map[string]any, st *stateIndex) []string {
	if rc.Type != "google_container_cluster" {
		return nil
	}
	c, ok := gkeClusterIdentity(before, after)
	if !ok {
		return nil
	}
	sib := siblingScope{st: st, provider: rc.ProviderName, module: rc.ModuleAddress}
	var roots []string
	if !reflect.DeepEqual(before["node_config"], after["node_config"]) && gkeNodeConfigMirrorsFirstPool(before, after, c, sib) {
		roots = append(roots, "node_config")
	}
	if !reflect.DeepEqual(before["node_pool"], after["node_pool"]) && gkeNodePoolsGainedOnly(before["node_pool"], after["node_pool"], c, sib) {
		roots = append(roots, "node_pool")
	}
	return roots
}

// gkeCluster is what identifies a cluster to the pools that name it.
type gkeCluster struct {
	id, name, project, location string
}

// gkeClusterIdentity reads the cluster's identity, requiring every part non-empty and identical in
// both views: a cluster whose name, id, project or location changed is not one this tier reasons
// about.
func gkeClusterIdentity(before, after map[string]any) (gkeCluster, bool) {
	var c gkeCluster
	for _, f := range []struct {
		key string
		dst *string
	}{{"id", &c.id}, {"name", &c.name}, {"project", &c.project}, {"location", &c.location}} {
		v, ok := sameNonEmpty(before, after, f.key)
		if !ok {
			return gkeCluster{}, false
		}
		*f.dst = v
	}
	return c, true
}

// gkeNodePoolsGainedOnly verifies that the cluster's node_pool list lost and altered nothing, gained
// at least one element, and that every gained element is a distinct managed pool it mirrors.
func gkeNodePoolsGainedOnly(before, after any, c gkeCluster, sib siblingScope) bool {
	prior, okB := objectList(before)
	now, okA := objectList(after)
	if !okB || !okA {
		return false
	}
	for _, p := range prior {
		if !containsDeep(now, p) {
			return false
		}
	}
	// Pool names are unique within a cluster. Two elements sharing one — gained or kept — is not a
	// shape the API produces, and would let one managed pool vouch for two elements.
	seen := map[string]bool{}
	for _, e := range now {
		name, _ := e.(map[string]any)["name"].(string)
		if seen[name] {
			return false
		}
		seen[name] = true
	}
	gained := 0
	for _, e := range now {
		if containsDeep(prior, e) {
			continue
		}
		if _, ok := gkeManagedPoolFor(e.(map[string]any), c, sib); !ok {
			return false
		}
		gained++
	}
	return gained > 0
}

// gkeNodeConfigMirrorsFirstPool verifies that the cluster's node_config went from empty to exactly
// the node_config of its first node_pool element, and that that element is a managed pool it
// mirrors.
func gkeNodeConfigMirrorsFirstPool(before, after map[string]any, c gkeCluster, sib siblingScope) bool {
	for _, v := range []map[string]any{before, after} {
		if b, _ := v["remove_default_node_pool"].(bool); !b {
			return false
		}
	}
	if !emptyOrNull(before["node_config"]) || emptyOrNull(after["node_config"]) {
		return false
	}
	pools, ok := objectList(after["node_pool"])
	if !ok || len(pools) == 0 {
		return false
	}
	pool, ok := gkeManagedPoolFor(pools[0].(map[string]any), c, sib)
	if !ok {
		return false
	}
	mine, ok := withoutPriorDerived(map[string]any{"node_config": after["node_config"]}, true)
	if !ok {
		return false
	}
	theirs, _ := withoutPriorDerived(map[string]any{"node_config": pool["node_config"]}, false)
	return mirrors(mine["node_config"], theirs["node_config"])
}

// gkeManagedPoolFor returns the REFRESHED value of the one managed google_container_node_pool in
// scope that element e of cluster c stands for, when there is exactly one, it is present in both
// views naming this cluster, and e mirrors its refreshed value. Otherwise false.
func gkeManagedPoolFor(e map[string]any, c gkeCluster, sib siblingScope) (map[string]any, bool) {
	name, _ := e["name"].(string)
	if name == "" {
		return nil, false
	}
	names := func(v map[string]any) bool {
		n, _ := v["name"].(string)
		cl, _ := v["cluster"].(string)
		p, _ := v["project"].(string)
		l, _ := v["location"].(string)
		return n == name && (cl == c.name || cl == c.id) && p == c.project && l == c.location
	}
	addrs := make([]string, 0, len(sib.st.refreshed))
	for a, obj := range sib.st.refreshed {
		if sib.holds(obj, "google_container_node_pool") && names(obj.values) {
			addrs = append(addrs, a)
		}
	}
	sort.Strings(addrs)
	if len(addrs) != 1 {
		// None: the pool is not managed here. More than one: which pool the element stands for is
		// ambiguous, and an ambiguous vouch is no vouch.
		return nil, false
	}
	live := sib.st.refreshed[addrs[0]]
	rec, ok := sib.st.recorded[addrs[0]]
	if !ok || !sib.holds(rec, "google_container_node_pool") || !names(rec.values) {
		return nil, false
	}
	mine, ok := withoutPriorDerived(e, true)
	if !ok {
		return nil, false
	}
	theirs, _ := withoutPriorDerived(live.values, false)
	for k, v := range mine {
		lv, present := theirs[k]
		if !present || !mirrors(v, lv) {
			return nil, false
		}
	}
	return live.values, true
}

// mirrors reports whether a and b are the same value, reading null and an empty list or map as the
// same (the empty_collection identity: both denote no elements). Maps compare over the union of
// their keys, an absent key reading as null; lists compare position by position. Scalars must be
// identical — "" is not null and 0 is not false.
func mirrors(a, b any) bool {
	if emptyOrNull(a) && emptyOrNull(b) {
		return true
	}
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok {
			return false
		}
		for k, v := range x {
			if !mirrors(v, y[k]) {
				return false
			}
		}
		for k, v := range y {
			if _, seen := x[k]; !seen && !mirrors(nil, v) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !mirrors(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

// emptyOrNull reports whether v is null, an empty list or an empty map.
func emptyOrNull(v any) bool {
	return v == nil || emptyCollection(v)
}

// objectList reads a nested block list whose every element is an object, with null as empty.
func objectList(v any) ([]any, bool) {
	if v == nil {
		return nil, true
	}
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	for _, e := range list {
		if _, ok := e.(map[string]any); !ok {
			return nil, false
		}
	}
	return list, true
}

// withoutPriorDerived returns a copy of a node-pool-shaped object (a cluster's node_pool element, a
// google_container_node_pool's value, or {"node_config": ...}) without the three fields the provider
// fills from PRIOR STATE rather than from the API (hashicorp/google 6.50.0):
//
//   - name_prefix — flattenNodePool copies d.Get(prefix+"name_prefix");
//   - network_config[*].create_pod_range — flattenNodeNetworkConfig copies the old value ("API
//     doesn't return this value so we set the old one");
//   - node_config[*].taint — flattenTaints keeps only the API taints whose keys the PRIOR node
//     config declared. The full API set is effective_taints, which is still compared.
//
// None of them is something the cloud reported, so comparing them would compare the cluster's
// recorded value against the pool's configured one — a mismatch that says nothing about the live
// pool. They are not skipped silently, though: when cluster is true the object is the CLUSTER's
// side, whose prior is empty on every path this tier accepts, so each must hold exactly what an
// empty prior yields (null/"" / null/false / null/[]); anything else is unexplained and reports
// false.
func withoutPriorDerived(v map[string]any, cluster bool) (map[string]any, bool) {
	out := make(map[string]any, len(v))
	for k, x := range v {
		out[k] = x
	}
	if cluster {
		if s, ok := stringOrNull(out["name_prefix"]); !ok || s != "" {
			return nil, false
		}
	}
	delete(out, "name_prefix")
	for _, f := range []struct{ block, field string }{{"network_config", "create_pod_range"}, {"node_config", "taint"}} {
		list, ok := objectList(out[f.block])
		if !ok {
			return nil, false
		}
		stripped := make([]any, 0, len(list))
		for _, e := range list {
			m := e.(map[string]any)
			if cluster {
				switch x := m[f.field].(type) {
				case nil:
				case bool:
					if x {
						return nil, false
					}
				default:
					if !emptyCollection(x) {
						return nil, false
					}
				}
			}
			c := make(map[string]any, len(m))
			for k, x := range m {
				if k != f.field {
					c[k] = x
				}
			}
			stripped = append(stripped, c)
		}
		if list != nil {
			out[f.block] = stripped
		}
	}
	return out, true
}
