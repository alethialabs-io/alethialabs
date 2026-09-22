// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// This file resolves a project's cloud-indifferent config to concrete per-provider values
// at provision time (the abstract→concrete seam). Each helper prefers the abstract field
// and falls back to the legacy concrete value, so snapshots from before the abstraction
// still provision unchanged.

// resolveRegion maps a canonical region id to the provider's region code. If the value is
// already a provider-specific code (legacy snapshots) it isn't in the catalog and is
// returned unchanged.
func resolveRegion(provider, region string) string {
	if r, ok := catalog.MustLoad().Region(region, provider); ok && r != "" {
		return r
	}
	return region
}

// resolveDBEngine returns the concrete provider engine value + version for a database.
// Prefers EngineFamily (postgres/mysql) via the catalog; falls back to the legacy Engine.
func resolveDBEngine(provider string, db types.ProjectDatabaseConfig) (engine, version string) {
	if db.EngineFamily != "" {
		if e, ok := catalog.MustLoad().DBEngine(provider, db.EngineFamily); ok {
			v := db.EngineVersion
			if v == "" {
				v = e.DefaultVersion
			}
			return e.Value, v
		}
	}
	return db.Engine, db.EngineVersion
}

// resolveCacheNodeType returns the concrete provider cache SKU. Prefers MemoryGB (nearest
// catalog tier); falls back to the legacy NodeType — matching the abstract-first precedence of
// resolveDBEngine and the file invariant, so a stale legacy NodeType can't shadow MemoryGB (#1002).
func resolveCacheNodeType(provider string, c types.ProjectCacheConfig) string {
	if c.MemoryGB > 0 {
		if t, ok := catalog.MustLoad().NearestCacheTier(provider, c.MemoryGB); ok {
			return t.Value
		}
	}
	return c.NodeType
}

// resolveK8sVersion returns the cluster's Kubernetes version: the caller's explicit value
// when set, otherwise the catalog's per-provider default. Keeping this in the catalog SSOT
// (rather than an inline literal per provider) is why the managed-cloud defaults no longer
// drift — bump packages/core/catalog/catalog.json to change them. Returns "" only when the
// provider has no catalog default (e.g. Hetzner, whose version is picked by Talos).
func resolveK8sVersion(provider, configVersion string) string {
	if configVersion != "" {
		return configVersion
	}
	if v, ok := catalog.MustLoad().DefaultK8sVersion(provider); ok {
		return v
	}
	return ""
}

// ResolveInstanceTypes returns the concrete provider instance type list for the cluster.
// Prefers explicit InstanceTypes; otherwise resolves NodeSize to the nearest catalog SKU.
//
// EXPORTED because it is the only answer to "which machine types will this deploy actually buy",
// and more than the providers need that answer. provisioner's node-fit gate (#3855 cause B) has to
// ask the SAME question this file answers: it originally read `Cluster.InstanceTypes` directly and
// was therefore blind to every project using the abstract, cloud-indifferent NodeSize — the path
// this codebase PREFERS. A gcp `node_size` of 2 vCPU / 4 GiB resolves here to `e2-medium`, the one
// shape measured unable to host the control plane, and the gate never saw it.
//
// So there is one resolver and both callers use it. A second copy in the gate would be a second
// source of truth that drifts the first time this precedence changes, and the drift would be
// silent: the gate would go on passing while checking a machine type the deploy does not buy.
func ResolveInstanceTypes(provider string, cl types.ProjectClusterConfig) []string {
	if len(cl.InstanceTypes) > 0 {
		return cl.InstanceTypes
	}
	if cl.NodeSize != nil {
		if i, ok := catalog.MustLoad().NearestInstance(provider, cl.NodeSize.VCPU, cl.NodeSize.MemoryGB, "general"); ok {
			return []string{i.Value}
		}
	}
	return nil
}
