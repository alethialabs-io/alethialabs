// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
// catalog tier); falls back to the legacy NodeType.
func resolveCacheNodeType(provider string, c types.ProjectCacheConfig) string {
	if c.NodeType != "" {
		return c.NodeType
	}
	if c.MemoryGB > 0 {
		if t, ok := catalog.MustLoad().NearestCacheTier(provider, c.MemoryGB); ok {
			return t.Value
		}
	}
	return c.NodeType
}

// resolveInstanceTypes returns the concrete provider instance type list for the cluster.
// Prefers explicit InstanceTypes; otherwise resolves NodeSize to the nearest catalog SKU.
func resolveInstanceTypes(provider string, cl types.ProjectClusterConfig) []string {
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
