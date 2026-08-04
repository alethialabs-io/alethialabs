// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type gcpProvider struct{}

func (p *gcpProvider) Name() string { return "gcp" }

func (p *gcpProvider) RequiredCLIs() []string {
	// CLI-free: the runner mints the GKE OAuth token in-process (kube-token exec-plugin),
	// replacing gcloud + gke-gcloud-auth-plugin. Only cluster tooling remains.
	return []string{"kubectl", "helm"}
}

// ValidateConfig refuses a GCP project config the GKE templates cannot provision: the shared
// node-pool sizing invariants, plus the `gke_disk_size_gb` floor the template itself declares.
//
// GCP is STRUCTURALLY EXEMPT from the network-CIDR floor every other cloud carries, and that is
// a deliberate absence rather than a gap. The other templates carve their subnets out of the
// user's CIDR with cidrsubnet(), so a too-narrow CIDR is a hard tofu error; GCP uses
// `var.network_cidr` VERBATIM as the subnetwork's ip_cidr_range
// (infra/templates/project/gcp/modules/vpc-network/main.tf:53) and puts pods and services in
// SECONDARY ranges of their own. There is nothing to carve, so there is no floor to derive.
// TestNetworkCIDRFloorsMatchTemplates asserts that verbatim use still holds — the day GCP
// starts carving, the exemption reds instead of quietly becoming wrong.
func (p *gcpProvider) ValidateConfig(config *types.ProjectConfig) error {
	if config == nil {
		return fmt.Errorf("ProjectConfig is required")
	}
	if err := validateNodeSizing(config); err != nil {
		return err
	}
	return validateNodeDiskSize(config, "gke_disk_size_gb", gcpNodeDiskFloorGB)
}

func (p *gcpProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	enableAutopilot := false
	if v, ok := config.Cluster.ProviderConfig["enable_autopilot"]; ok {
		if b, ok := v.(bool); ok {
			enableAutopilot = b
		}
	}

	// Seeded by the canvas's DNS switches; an explicit provider_config key still overrides (#1810).
	cloudArmorEnabled := config.DNS.WafEnabled
	if v, ok := config.DNS.ProviderConfig["cloud_armor"]; ok {
		if b, ok := v.(bool); ok {
			cloudArmorEnabled = b
		}
	}
	// No `managed_certificate` override here: GCP converged onto cert-manager (#1858), so the
	// template declares no certificate variable for one to act on. The escape hatch still WORKS —
	// it moved to `managedCertificateAsk` in packages/core/argocd/infra_facts.go, where the decision
	// now lives, so it covers every cloud rather than being restated per provider.

	provisionNetwork := config.Network.ProvisionNetwork
	if !provisionNetwork && config.Network.NetworkID == "" {
		provisionNetwork = true
	}

	// Firestore point-in-time recovery, aggregated with ANY across the canvas's NoSQL tables.
	// GCP allows ONE Firestore database per project, and what the canvas calls a "table" is a
	// collection inside it — so a per-table switch has no per-table resource to land on. PITR is a
	// property of the DATABASE, so one table asking for it turns it on for the whole database.
	// Deliberately written INLINE rather than as a `pitr := anyTableWantsPITR(...)` helper: the
	// carrier tracer (apps/console/scripts/lib/go-tfvars-trace.mjs) follows a field into the quoted
	// key derived FROM IT, and a helper that reads the field and returns a bare scalar writes no
	// quoted key in its own body — the fix would ship working and still score as "not carried".
	firestorePITR := false
	for _, t := range config.NosqlTables {
		if t.PointInTimeRecovery {
			firestorePITR = true
		}
	}

	tfvars := map[string]interface{}{
		"project_name": config.ProjectName,
		"project_id":   config.CloudAccountID,
		"region":       resolveRegion("gcp", config.Region),
		"environment":  config.EnvironmentStage,

		// Network
		"provision_network": provisionNetwork,
		"network_cidr":      orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"single_cloud_nat":  config.Network.SingleNatGateway,

		// GKE
		"provision_gke":        true,
		"gke_cluster_version":  resolveK8sVersion("gcp", config.Cluster.ClusterVersion),
		"gke_enable_autopilot": enableAutopilot,

		// DNS
		"cloud_dns_enabled":   config.DNS.Enabled,
		"cloud_dns_domain":    config.DNS.DomainName,
		"cloud_dns_zone_name": config.DNS.ZoneID,
		// No certificate tfvar: GCP's managed certificate is issued IN-CLUSTER by cert-manager
		// (#1858). `google_compute_managed_ssl_certificate` and the pre-shared-cert annotation that
		// named it are deleted, so nothing in the template consumes the switch. Emitting it anyway
		// would be dropped at plan time (OpenTofu discards a root variable the template does not
		// declare) while the offer-parity guard still traced the emit and scored the cell as
		// carried — a green cell for a value that never reaches a plan.

		// Cloud Armor
		"cloud_armor_enabled": cloudArmorEnabled,

		// Pub/Sub
		"create_pubsub": len(config.Queues) > 0 || len(config.Topics) > 0,
		"pubsub_topics": buildPubSubTopics(config.Topics, config.Queues),

		// Memorystore
		"create_memorystore": len(config.Caches) > 0,

		// Firestore. The template's Firestore model is a SINGLE per-project database
		// (create_firestore + firestore_database_type/location vars) — GCP allows one Firestore
		// DB per project and NoSQL "tables" are collections within it, created by the app, not
		// tofu. There is deliberately no per-table `firestore_databases` list: a list var of that
		// name was never declared in variables.tf and was silently dropped, and the builder that
		// produced it (`buildFirestoreDatabases`) was dead code kept alive only by its own unit
		// test — the canonical false positive the carrier tracer was written to catch. Both are
		// gone. Everything per-table the database can actually honor is aggregated here instead.
		"create_firestore":                 len(config.NosqlTables) > 0,
		"firestore_point_in_time_recovery": firestorePITR,

		// Artifact Registry (container registry). `artifact_registry_repos` drives the module's
		// for_each — one repository per NATIVE registry component. Nothing emitted it at all, so
		// `provision_artifact_registry` read true from the mere PRESENCE of a registry row while
		// the map resolved empty, and GCP created ZERO repositories (#1835) — the same defect the
		// ECR names map had before buildECRNamesMap existed. Both are derived from the one builder
		// now, so the flag and the repositories cannot disagree again.
		//
		// The builder is called twice rather than hoisted to a local, and that is not an oversight:
		// the offer-parity carrier probe resolves which ROOT tfvar a builder's nested keys belong to
		// by finding `"<root>": <builder>(` — a local in between makes it resolve to nothing, and
		// `immutable_tags` is then judged as if it were a top-level variable, which no template
		// declares. It is a pure function over a handful of registry rows.
		"provision_artifact_registry": len(buildArtifactRegistryRepos(config)) > 0,
		"artifact_registry_repos":     buildArtifactRegistryRepos(config),

		// Cloud Storage
		"create_cloud_storage":  len(config.StorageBuckets) > 0,
		"cloud_storage_buckets": buildGCSBuckets(config.StorageBuckets),

		// Secrets
		"custom_secrets": buildGCPSecrets(config.Secrets),

		// Cloud SQL
		"create_cloud_sql": len(config.Databases) > 0,
		// TODO: wire from ProjectConfig when an AuthorizedNetworks field is added
		"cloud_sql_authorized_networks": []map[string]interface{}{},
	}

	if len(config.Databases) > 0 {
		db := config.Databases[0]
		fam := db.EngineFamily
		if fam == "" {
			fam = "postgres"
			if db.Engine == "mysql" || db.Engine == "aurora-mysql" {
				fam = "mysql"
			}
		}
		engine := "POSTGRES"
		if fam == "mysql" {
			engine = "MYSQL"
		}
		tfvars["cloud_sql_engine"] = engine
		if _, version := resolveDBEngine("gcp", db); version != "" {
			tfvars["cloud_sql_engine_version"] = version
		}
		if db.InstanceClass != "" {
			tfvars["cloud_sql_tier"] = db.InstanceClass
		}
		if db.Port != nil {
			tfvars["cloud_sql_port"] = *db.Port
		}
		if db.BackupRetentionDays != nil {
			tfvars["cloud_sql_backup_retention_days"] = *db.BackupRetentionDays
		}
		if db.IamAuth != nil {
			tfvars["cloud_sql_iam_auth"] = *db.IamAuth
		}
		// Generic passthrough — see mergeProviderConfig (aws_provider.go). cloud_sql_iam_auth is
		// reserved UNCONDITIONALLY: db.IamAuth == nil leaves it unset, and without this a
		// provider_config key could switch keyless on for a cell the canvas never offered, walking
		// around the offer-parity guard (#1508). `log_exports` is AWS-only — no GCP template variable
		// declares a Cloud SQL log-export set — so it is reserved rather than emitted undeclared.
		mergeProviderConfig(tfvars, db.ProviderConfig, "log_exports", "cloud_sql_iam_auth")
	}

	if len(config.Caches) > 0 {
		cache := config.Caches[0]

		// The engine the user picked decides WHICH Memorystore product runs. Until now nothing read
		// `cache.Engine` on any cloud, so picking Valkey silently provisioned Redis (#1420). On GCP
		// this is a genuine fork rather than a flag: Valkey is `google_memorystore_instance`, a
		// cluster-shaped product sized by SHARDS, while Redis is `google_redis_instance`, sized by a
		// memory figure. Anything not explicitly Valkey stays Redis, so an engine-less config is
		// unchanged.
		valkey := cache.Engine == types.CacheEngineValkey
		tfvars["create_memorystore_valkey"] = valkey
		tfvars["create_memorystore"] = !valkey

		if valkey {
			// Shards from the cloud-indifferent memory size. SHARED_CORE_NANO carries ~1.4 GB per
			// shard; round UP so the instance is never smaller than what was asked for, and never go
			// below one shard.
			if cache.MemoryGB > 0 {
				tfvars["memorystore_valkey_shard_count"] = gcpValkeyShards(cache.MemoryGB)
			}
			if cache.NumCacheNodes != nil && *cache.NumCacheNodes > 1 {
				// Replicas per shard, not a node count — the service manages the primaries.
				tfvars["memorystore_valkey_replica_count"] = *cache.NumCacheNodes - 1
			}
			if v := gcpMemorystoreValkeyVersion(cache.EngineVersion); v != "" {
				tfvars["memorystore_valkey_engine_version"] = v
			}
		} else {
			// Map ProjectCacheConfig onto the ONLY Memorystore tfvars the GCP template declares:
			// memorystore_tier (BASIC|STANDARD_HA), memorystore_memory_size_gb (whole GB), and
			// memorystore_redis_version (the REDIS_x_y enum). The provider previously emitted
			// memorystore_engine / memorystore_instance_type / memorystore_multi_az — none declared
			// in variables.tf, so a customer's cache shape was silently dropped (this wiring gap).
			//
			// Tier: STANDARD_HA (replicated, high-availability) when the config asks for more than one
			// node OR explicit multi-AZ; otherwise the template default (BASIC) stands.
			if (cache.NumCacheNodes != nil && *cache.NumCacheNodes > 1) || (cache.MultiAz != nil && *cache.MultiAz) {
				tfvars["memorystore_tier"] = "STANDARD_HA"
			}
			// Size: the cloud-indifferent MemoryGB is the memorystore_memory_size_gb number directly.
			// GCP requires whole GB, so round. The M1..M4 NearestCacheTier labels are the console tier
			// NAMES, not this template's size/tier model, so they are deliberately NOT used here.
			if cache.MemoryGB > 0 {
				tfvars["memorystore_memory_size_gb"] = int(math.Round(cache.MemoryGB))
			}
			// Version: the var accepts only the REDIS_x_y enum — passing a raw "7.1" fails the apply.
			if v := gcpMemorystoreRedisVersion(cache.EngineVersion); v != "" {
				tfvars["memorystore_redis_version"] = v
			}
		}
	}

	if inst := resolveInstanceTypes("gcp", config.Cluster); len(inst) > 0 {
		tfvars["gke_instance_types"] = inst
	}
	if config.Cluster.NodeMinSize > 0 {
		tfvars["gke_node_min_size"] = config.Cluster.NodeMinSize
	}
	if config.Cluster.NodeMaxSize > 0 {
		tfvars["gke_node_max_size"] = config.Cluster.NodeMaxSize
	}
	if config.Cluster.NodeDesiredSize > 0 {
		tfvars["gke_node_desired_size"] = config.Cluster.NodeDesiredSize
	}
	if config.Cluster.NodeDiskSizeGB != nil {
		tfvars["gke_disk_size_gb"] = *config.Cluster.NodeDiskSizeGB
	}

	if !provisionNetwork && config.Network.NetworkID != "" {
		tfvars["network_id"] = config.Network.NetworkID
	}
	// Brownfield subnet selection (#1352): the user-picked subnet self-links. Written only
	// on an existing network and only when non-empty, so an empty selection leaves the key
	// absent (auto-discover, today's behaviour) and gcp_provider_test's absence assertions
	// stay green. The template prefers this over its region-regex subnet scan.
	if !provisionNetwork && len(config.Network.SubnetIDs) > 0 {
		tfvars["subnet_ids"] = config.Network.SubnetIDs
	}

	// Generic passthrough — see mergeProviderConfig (aws_provider.go). Reserved keys
	// are consumed above under a different tfvar name.
	// B1.2: classification → resource labels (+ the always-on project-id/environment-id sweep
	// handles), GCP-styled (lowercase `alethia_...`, ≤63). Set before mergeProviderConfig so a
	// user's provider_config can't shadow it. Consumed by the classification_tags var (B1.3).
	tfvars["classification_tags"] = classificationTags(config, gcpTagStyle)

	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig, "enable_autopilot")
	mergeProviderConfig(tfvars, config.DNS.ProviderConfig, "cloud_armor", "managed_certificate")

	return tfvars
}

func (p *gcpProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	clusterName := ExtractClusterName(outputs)
	if clusterName == "" {
		return fmt.Errorf("no GKE cluster name in outputs")
	}
	fmt.Fprintf(stdout, "Configuring kubeconfig for GKE cluster %s...\n", clusterName)

	// CLI-free: write a kubeconfig that authenticates via the runner's own `kube-token`
	// exec-plugin (in-process GKE OAuth token from the keyless WIF creds) instead of
	// shelling `gcloud container clusters get-credentials`. Endpoint + CA come from the
	// tofu outputs (sensitive, consumed in-process — never persisted).
	endpoint := extractOutputString(outputs, "gke_cluster_endpoint")
	if endpoint == "" {
		endpoint = extractOutputString(outputs, "cluster_endpoint") // BYO-IaC generic fallback
	}
	ca := extractOutputString(outputs, "gke_cluster_ca_certificate")
	if ca == "" {
		ca = extractOutputString(outputs, "cluster_ca_certificate") // BYO-IaC generic fallback
	}
	if endpoint == "" || ca == "" {
		return fmt.Errorf("missing GKE endpoint/CA in tofu outputs (gke_cluster_endpoint/gke_cluster_ca_certificate or generic cluster_endpoint/cluster_ca_certificate)")
	}
	if !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}
	return writeExecKubeconfig(
		clusterName,
		endpoint,
		ca,
		[]string{"kube-token", "--provider", "gcp"},
		stdout,
	)
}

// buildPubSubTopics maps canvas topics AND canvas queues onto the `pubsub_topics` tfvar — GCP has no
// queue primitive, so a queue is modelled as a topic with exactly one subscription.
//
// Ordered delivery is a property of the SUBSCRIPTION (`enable_message_ordering`), never of the
// topic, so the queue's switch travels on the single subscription the queue owns. A canvas TOPIC is
// fan-out with subscribers Alethia does not model, and ordering there would be a promise about
// publishers we cannot see — its subscriptions are emitted explicitly unordered rather than left
// out, so the tfvars shape is the same for both origins.
func buildPubSubTopics(topics []types.ProjectTopicConfig, queues []types.ProjectQueueConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, t := range topics {
		subs := []map[string]interface{}{}
		for _, s := range t.Subscriptions {
			subs = append(subs, map[string]interface{}{
				"name":                    s.Endpoint,
				"ack_deadline_seconds":    10,
				"enable_message_ordering": false,
			})
		}
		result[t.Name] = map[string]interface{}{
			"message_retention_duration": "86400s",
			"subscriptions":              subs,
		}
	}
	for _, q := range queues {
		ackDeadline := 10
		if q.VisibilityTimeout != nil {
			ackDeadline = *q.VisibilityTimeout
		}

		retention := "86400s"
		if q.MessageRetention != nil {
			retention = fmt.Sprintf("%ds", *q.MessageRetention)
		}

		sub := map[string]interface{}{
			"name":                 q.Name + "-sub",
			"ack_deadline_seconds": ackDeadline,
		}
		sub["enable_message_ordering"] = derefBoolOr(q.Ordered, false)
		subs := []map[string]interface{}{sub}
		result[q.Name] = map[string]interface{}{
			"message_retention_duration": retention,
			"subscriptions":              subs,
		}
	}
	return result
}

// gcpMemorystoreRedisVersion maps a plain Redis version ("7.1", "6.2", "5") to the REDIS_x_y enum
// that the GCP template's memorystore_redis_version variable (and the google_redis_instance API)
// requires — a raw semver like "7.1" fails the apply. GCP offers REDIS_7_2, REDIS_7_0, REDIS_6_X,
// REDIS_5_0, REDIS_4_0, REDIS_3_2; a version with no exact enum snaps to the nearest lower one in
// its major (e.g. "7.1" -> REDIS_7_0). Returns "" for an empty or unmappable version, so the caller
// leaves the template default. An already-enum value ("REDIS_7_0") passes through unchanged.
func gcpMemorystoreRedisVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if strings.HasPrefix(v, "REDIS_") {
		return v
	}
	major := v
	minor := ""
	if i := strings.IndexByte(v, '.'); i >= 0 {
		major = v[:i]
		minor = v[i+1:]
	}
	switch major {
	case "7":
		// GCP has REDIS_7_2 and REDIS_7_0 (no 7_1) — 7.2+ -> 7_2, everything else in the 7 line -> 7_0.
		if len(minor) > 0 && minor[0] >= '2' {
			return "REDIS_7_2"
		}
		return "REDIS_7_0"
	case "6":
		return "REDIS_6_X"
	case "5":
		return "REDIS_5_0"
	case "4":
		return "REDIS_4_0"
	case "3":
		return "REDIS_3_2"
	default:
		return ""
	}
}

func buildGCPSecrets(secrets []types.ProjectSecretConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(secrets))
	for _, s := range secrets {
		if !secretProvisionedNatively(s.Provider) {
			continue // read via ESO from its pluggable/cross-account store, not created here
		}
		result = append(result, map[string]interface{}{
			"name":          s.Name,
			"generate":      s.Generate,
			"length":        s.Length,
			"special_chars": s.SpecialChars,
		})
	}
	return result
}

// buildArtifactRegistryRepos collects the Artifact Registry repositories the template must create,
// keyed by the registry component's logical name — the SAME key `artifact_registry_urls` is keyed
// by, so a caller can look a repository's push URL up by the name the user typed.
//
// It did not exist. `provision_artifact_registry` was emitted from the mere PRESENCE of a registry
// row while `artifact_registry_repos` was emitted by nothing, so the module's for_each resolved to
// {} and a GCP project with a native registry got ZERO repositories and an empty URL map (#1835).
// That is the identical defect buildECRNamesMap was written to fix on AWS.
//
// Only NATIVE registry components produce a repository. Unlike ECR's map this deliberately does NOT
// also add one per repo-sourced service: `provision_artifact_registry` has always been derived from
// registry components alone, GCP has no build path pushing to a per-service repository, and giving
// a service a repository would raise a question this issue cannot answer honestly — which
// component's `immutable_tags` that repository should take.
//
// The map key is the component name UNNORMALIZED, because it is the lookup key of the URL output.
// The canvas already restricts a registry name to lowercase alphanumerics and hyphens; a snapshot
// that arrives with anything else is refused at plan time by the template's
// `artifact_registry_repo_names_valid` check rather than silently renamed here, which would break
// exactly the lookup this key exists for.
func buildArtifactRegistryRepos(config *types.ProjectConfig) map[string]interface{} {
	out := map[string]interface{}{}
	for _, r := range config.ContainerRegistries {
		// A pluggable registry (connectors.slug) is not Artifact Registry's to create.
		if r.Provider != "" && r.Provider != "native" {
			continue
		}
		if r.Name == "" {
			continue
		}
		// A nil switch is an older row or a hand-written snapshot. Read it as the SAFE setting —
		// which is also what the module's `optional(bool, …)` would have produced — rather than as
		// false, so nothing a live project already built is downgraded by the upgrade itself.
		immutable := true
		if r.ImmutableTags != nil {
			immutable = *r.ImmutableTags
		}
		// `vulnerability_scanning` reads the OPPOSITE default to immutable_tags, and for a reason
		// that is specific to GCP (#1844). Artifact Registry's per-repository enum is
		// INHERITED | DISABLED — there is no ENABLED — so the ON position can only mean "follow the
		// project default", which is on only when `containerscanning.googleapis.com` is enabled.
		// The template refuses the ON position when it is not (checks_registry.tf), so defaulting a
		// silent field to TRUE would make every project that has not done the onboarding
		// prerequisite fail at plan on a switch nobody set. Absent therefore reads as OFF, which
		// maps exactly onto DISABLED and asks nothing of the tenant.
		scanning := false
		if r.VulnerabilityScanning != nil {
			scanning = *r.VulnerabilityScanning
		}
		out[r.Name] = map[string]interface{}{
			"description":            "Container images for " + r.Name,
			"immutable_tags":         immutable,
			"vulnerability_scanning": scanning,
		}
	}
	return out
}

// buildGCSBuckets turns the canvas's buckets into the `cloud_storage_buckets` tfvar.
//
// `public_access` is emitted VERBATIM, and deliberately not as the `uniform_access` inversion this
// used to send. Uniform bucket-level access is a different feature: it disables per-object ACLs, it
// says nothing about whether the public may read the bucket, and Cloud Storage REFUSES to turn it
// back off more than 90 days after it was enabled — so a switch routed through it would become an
// unfixable apply failure on any bucket older than three months. The template keeps UBLA on
// permanently and decides public access with `public_access_prevention` plus an explicit allUsers
// IAM binding, which is the pair that actually implements the label the canvas shows.
func buildGCSBuckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		entry := map[string]interface{}{
			"name_suffix":   b.Name,
			"versioning":    b.Versioning,
			"public_access": b.PublicAccess,
			"cors_origins":  b.CorsOrigins,
			"cors_methods":  []string{"GET", "PUT", "POST"},
		}
		result = append(result, entry)
	}
	return result
}

var _ CloudProvider = (*gcpProvider)(nil)

// gcpValkeyShards converts the canvas's cloud-indifferent memory size into a Memorystore-for-Valkey
// shard count. The default node type carries roughly 1.4 GB per shard, so the size is divided and
// rounded UP — an instance smaller than what the user asked for is the one outcome that must not
// happen silently — with a floor of one shard.
func gcpValkeyShards(memoryGB float64) int {
	const gbPerShard = 1.4
	shards := int(math.Ceil(memoryGB / gbPerShard))
	if shards < 1 {
		return 1
	}
	return shards
}

// gcpMemorystoreValkeyVersion maps a plain Valkey version ("7.2", "8.0") to the VALKEY_x_y enum the
// resource requires — a raw semver fails the apply, exactly as it does on the Redis side. An empty or
// unparseable version returns "" so the template default stands rather than a guess being applied.
func gcpMemorystoreValkeyVersion(version string) string {
	if version == "" {
		return ""
	}
	if strings.HasPrefix(version, "VALKEY_") {
		return version
	}
	parts := strings.Split(version, ".")
	if len(parts) < 2 {
		return ""
	}
	major, minor := parts[0], parts[1]
	if major == "" || minor == "" {
		return ""
	}
	return "VALKEY_" + major + "_" + minor
}
