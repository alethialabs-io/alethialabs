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

// ResolveK8sVersion returns the cluster's Kubernetes version: the caller's explicit value
// when set, otherwise the catalog's per-provider default. Keeping this in the catalog SSOT
// (rather than an inline literal per provider) is why the managed-cloud defaults no longer
// drift — bump packages/core/catalog/catalog.json to change them. Returns "" only when the
// provider has no catalog default.
//
// EXPORTED because the version-compatibility gate (provisioner/deploy.go) must judge the version
// that will actually deploy, not the raw config value. A cluster with cluster_version unset deploys
// this default, and a gate that read the raw "" answered not_evaluable and skipped every
// compatibility check for exactly the clusters that pin nothing (#5314). One resolver, two callers:
// the managed clouds' ProviderTfvars and the gate both call this, so the two cannot disagree.
// The resolved value is never written back to the config or the snapshot — unset keeps meaning
// "follow the catalog". The console mirrors this in apps/console/lib/compat/resolve.ts, held equal
// by testdata/k8s_version_resolution.json.
//
// Hetzner is the one cloud whose tfvars do NOT forward this value: Talos needs a concrete patch, so
// hetzner_provider.go pins kubernetes_version itself. For an unset version the catalog default here
// and that pin share a minor, which is all the gate reads (provisioner/compat_resolved_version_test.go
// holds that).
func ResolveK8sVersion(provider, configVersion string) string {
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
	return resolveNodeTypes(provider, cl.InstanceTypes, cl.NodeSize)
}

// resolveNodeTypes is ResolveInstanceTypes over the two fields it reads, and the form every
// provider's ProviderTfvars calls. It takes the FIELDS rather than the cluster struct so the call
// site names both values that decide the instance-type tfvar: the config-carriage guard
// (apps/console/scripts/check-config-carriage.mjs) follows a value within one function body, and a
// call passing `config.Cluster` whole named neither — so `node_size` and `instance_types` read as
// "the guard cannot follow it" on every cloud, which is how #5267's dead `node_size` hid on that
// board. Same precedence, one implementation: the exported wrapper above delegates here.
func resolveNodeTypes(provider string, instanceTypes []string, nodeSize *types.NodeSize) []string {
	if len(instanceTypes) > 0 {
		return instanceTypes
	}
	if nodeSize != nil {
		if i, ok := catalog.MustLoad().NearestInstance(provider, nodeSize.VCPU, nodeSize.MemoryGB, "general"); ok {
			return []string{i.Value}
		}
	}
	return nil
}
