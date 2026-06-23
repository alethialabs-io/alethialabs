// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Placement discipline — "versatile model, disciplined provisioning". The data
// model lets every resource name its own cloud (types.Placement), but provisioning
// today supports a single-cloud CORE plus freely-placed PERIPHERY. A CORE resource
// whose effective cloud identity differs from the spec's primary identity is a hot
// cross-cloud data-plane edge — gated until the cross-cloud networking substrate
// exists.
//
// CORE (must colocate on the spec's primary cloud identity):
//   network, cluster, databases, caches, queues, topics, nosql_tables.
// PERIPHERY (may diverge freely — reached over the public internet / at build time
// or composed via the pluggable `categories` system, never over the cluster's
// private path): dns, observability, secrets, container_registries,
// storage_buckets, repositories.

// gateError describes why a hot cross-cloud edge can't be provisioned yet.
func gateError(resourceType, name, want, core string) error {
	return fmt.Errorf(
		"cross-cloud %s %q targets cloud identity %q but this stack's core runs on %q: "+
			"hot cross-cloud data-plane edges (compute reaching a primary datastore in "+
			"another cloud) are on the roadmap and require cross-cloud networking that "+
			"isn't available yet — move this resource onto the stack's primary cloud, or "+
			"model it as an independent per-cloud stack",
		resourceType, name, want, core)
}

// effectiveIdentity returns the resource's own cloud identity, or the core identity
// when the resource inherits (empty placement).
func effectiveIdentity(p types.Placement, core string) string {
	if p.CloudIdentityID != "" {
		return p.CloudIdentityID
	}
	return core
}

// ValidatePlacement enforces the provisioning discipline: it returns a gate error
// if any CORE resource is placed on a cloud identity other than the spec's primary
// one. PERIPHERY resources may diverge freely and are not checked here.
func ValidatePlacement(vc *types.SpecConfig) error {
	if vc == nil {
		return fmt.Errorf("SpecConfig is required")
	}
	core := vc.CloudIdentityID

	// CORE singletons.
	if id := effectiveIdentity(vc.Network.Placement, core); id != core {
		return gateError("network", "network", id, core)
	}
	if id := effectiveIdentity(vc.Cluster.Placement, core); id != core {
		return gateError("cluster", "cluster", id, core)
	}

	// CORE collections.
	for _, db := range vc.Databases {
		if id := effectiveIdentity(db.Placement, core); id != core {
			return gateError("database", db.Name, id, core)
		}
	}
	for _, c := range vc.Caches {
		if id := effectiveIdentity(c.Placement, core); id != core {
			return gateError("cache", c.Name, id, core)
		}
	}
	for _, q := range vc.Queues {
		if id := effectiveIdentity(q.Placement, core); id != core {
			return gateError("queue", q.Name, id, core)
		}
	}
	for _, t := range vc.Topics {
		if id := effectiveIdentity(t.Placement, core); id != core {
			return gateError("topic", t.Name, id, core)
		}
	}
	for _, n := range vc.NosqlTables {
		if id := effectiveIdentity(n.Placement, core); id != core {
			return gateError("nosql table", n.Name, id, core)
		}
	}
	return nil
}
