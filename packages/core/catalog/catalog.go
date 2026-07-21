// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package catalog is the single, cloud-indifferent source of truth that maps an
// abstract service spec (engine family, capability sizing, canonical region) to
// concrete per-provider values. The same JSON document is embedded here for the Go
// resolver and code-generated into TypeScript for the console UI, so the two never
// drift. Resolution (abstract -> concrete) happens at provision time inside each
// provider's ProviderTfvars via these helpers.
package catalog

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"sync"
)

//go:embed catalog.json
var catalogJSON []byte

// Catalog is the parsed catalog document.
type Catalog struct {
	Version   int                         `json:"version"`
	Providers []ProviderMeta              `json:"providers"`
	Regions   []Region                    `json:"regions"`
	Compute   map[string]ComputeProvider  `json:"compute"`
	Database  map[string]DatabaseProvider `json:"database"`
	Cache     map[string]CacheProvider    `json:"cache"`
}

// ProviderMeta carries display + service-naming metadata for one cloud.
type ProviderMeta struct {
	Slug            string `json:"slug"`
	Name            string `json:"name"`
	ClusterService  string `json:"cluster_service"`
	NetworkName     string `json:"network_name"`
	DNSService      string `json:"dns_service"`
	DatabaseService string `json:"database_service"`
	CacheService    string `json:"cache_service"`
	NosqlService    string `json:"nosql_service"`
	QueueService    string `json:"queue_service"`
	TopicService    string `json:"topic_service"`
	StorageService  string `json:"storage_service"`
	RegistryService string `json:"registry_service"`
	SecretsService  string `json:"secrets_service"`
}

// Region is a canonical (cloud-indifferent) region with its concrete per-provider code.
type Region struct {
	ID    string            `json:"id"`
	Label string            `json:"label"`
	Group string            `json:"group"`
	Codes map[string]string `json:"codes"`
}

// ComputeProvider is the per-provider compute inventory (cluster node instances).
type ComputeProvider struct {
	DefaultInstance   string     `json:"default_instance"`
	DefaultK8sVersion string     `json:"default_k8s_version"`
	K8sVersions       []string   `json:"k8s_versions"`
	AutoscalerKey     string     `json:"autoscaler_key"`
	Instances         []Instance `json:"instances"`
}

// Instance is one concrete machine type with its capability metadata.
type Instance struct {
	Value    string  `json:"value"`
	Label    string  `json:"label"`
	VCPU     float64 `json:"vcpu"`
	MemoryGB float64 `json:"memory_gb"`
	Family   string  `json:"family"`
	Cost     string  `json:"cost"`
}

// DatabaseProvider is the per-provider managed-database inventory.
type DatabaseProvider struct {
	Capacity Capacity   `json:"capacity"`
	Engines  []DBEngine `json:"engines"`
}

// DBEngine maps an abstract engine family to a concrete provider engine + default version.
type DBEngine struct {
	Family         string `json:"family"`
	Value          string `json:"value"`
	Label          string `json:"label"`
	DefaultVersion string `json:"default_version"`
}

// Capacity describes the provider's scaling-unit model.
type Capacity struct {
	Unit       string  `json:"unit"`
	Min        float64 `json:"min"`
	Max        float64 `json:"max"`
	Step       float64 `json:"step"`
	DefaultMin float64 `json:"default_min"`
	DefaultMax float64 `json:"default_max"`
}

// CacheProvider is the per-provider in-memory-cache inventory.
type CacheProvider struct {
	DefaultTier string      `json:"default_tier"`
	Tiers       []CacheTier `json:"tiers"`
}

// CacheTier is one concrete cache SKU with its memory size.
type CacheTier struct {
	Value    string  `json:"value"`
	Label    string  `json:"label"`
	MemoryGB float64 `json:"memory_gb"`
	Cost     string  `json:"cost"`
}

var (
	loaded  *Catalog
	loadErr error
	once    sync.Once
)

// Load parses and memoizes the embedded catalog.
func Load() (*Catalog, error) {
	once.Do(func() {
		var c Catalog
		if err := json.Unmarshal(catalogJSON, &c); err != nil {
			loadErr = fmt.Errorf("catalog: parse embedded catalog.json: %w", err)
			return
		}
		loaded = &c
	})
	return loaded, loadErr
}

// MustLoad returns the catalog or panics — the JSON is embedded and validated by a
// test, so a parse failure is a build-time defect, not a runtime condition.
func MustLoad() *Catalog {
	c, err := Load()
	if err != nil {
		panic(err)
	}
	return c
}

// Provider returns the metadata for a provider slug.
func (c *Catalog) Provider(slug string) (ProviderMeta, bool) {
	for _, p := range c.Providers {
		if p.Slug == slug {
			return p, true
		}
	}
	return ProviderMeta{}, false
}

// Region resolves a canonical region id to a provider-specific region code.
func (c *Catalog) Region(canonicalID, provider string) (string, bool) {
	for _, r := range c.Regions {
		if r.ID == canonicalID {
			code, ok := r.Codes[provider]
			return code, ok
		}
	}
	return "", false
}

// DefaultK8sVersion returns the catalog's default Kubernetes minor for a provider's
// managed cluster (e.g. "1.35"). Returns false only for a provider the catalog has no default
// for — an unknown/unlisted provider — in which case the caller falls back to its own passthrough.
// All five managed clouds, including Hetzner, currently pin a default in catalog.json.
func (c *Catalog) DefaultK8sVersion(provider string) (string, bool) {
	if cp, ok := c.Compute[provider]; ok && cp.DefaultK8sVersion != "" {
		return cp.DefaultK8sVersion, true
	}
	return "", false
}

// NearestInstance picks the provider machine type closest to the requested
// capability. It prefers the requested family (general/compute/memory/gpu) when that
// family has any members, then minimizes capability distance (memory weighted with
// vCPU). Returns false only when the provider has no compute inventory at all.
func (c *Catalog) NearestInstance(provider string, vcpu, memoryGB float64, family string) (Instance, bool) {
	cp, ok := c.Compute[provider]
	if !ok || len(cp.Instances) == 0 {
		return Instance{}, false
	}
	candidates := cp.Instances
	if family != "" {
		var sameFamily []Instance
		for _, in := range cp.Instances {
			if in.Family == family {
				sameFamily = append(sameFamily, in)
			}
		}
		if len(sameFamily) > 0 {
			candidates = sameFamily
		}
	}
	best := candidates[0]
	bestDist := capabilityDistance(best, vcpu, memoryGB)
	for _, in := range candidates[1:] {
		if d := capabilityDistance(in, vcpu, memoryGB); d < bestDist {
			best, bestDist = in, d
		}
	}
	return best, true
}

// capabilityDistance is a simple weighted L2 over (vCPU, memoryGB). Memory and vCPU
// are weighted comparably; ties resolve to the first (cheapest, since lists are
// authored cheapest-first).
func capabilityDistance(in Instance, vcpu, memoryGB float64) float64 {
	dv := in.VCPU - vcpu
	dm := in.MemoryGB - memoryGB
	return math.Sqrt(dv*dv + dm*dm)
}

// DBEngine resolves an abstract engine family (postgres/mysql) to the provider engine.
func (c *Catalog) DBEngine(provider, family string) (DBEngine, bool) {
	dp, ok := c.Database[provider]
	if !ok {
		return DBEngine{}, false
	}
	for _, e := range dp.Engines {
		if e.Family == family {
			return e, true
		}
	}
	return DBEngine{}, false
}

// NearestCacheTier picks the provider cache SKU whose memory is closest to (and, when
// possible, at least) the requested size. Returns false when the provider has no cache
// inventory.
func (c *Catalog) NearestCacheTier(provider string, memoryGB float64) (CacheTier, bool) {
	cp, ok := c.Cache[provider]
	if !ok || len(cp.Tiers) == 0 {
		return CacheTier{}, false
	}
	best := cp.Tiers[0]
	bestDist := math.Abs(best.MemoryGB - memoryGB)
	for _, t := range cp.Tiers[1:] {
		if d := math.Abs(t.MemoryGB - memoryGB); d < bestDist {
			best, bestDist = t, d
		}
	}
	return best, true
}
