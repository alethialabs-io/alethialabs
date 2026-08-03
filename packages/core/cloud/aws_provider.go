// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"
	"strings"

	coreaws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/eks"
)

// DefaultAuroraPostgresVersion is the single source of truth for the Aurora PostgreSQL minor that
// every unversioned AWS path provisions on. Four copies of this value used to live apart — here, in
// the template's `rds_config` variable (BOTH its optional() and whole-object defaults), in the rds
// module, and in the e2e max-config table — and nothing coupled them.
//
// That cost a nightly: AWS WITHDREW plain 16.6 (only the unrelated "16.6-limitless" remains), so
// every full-bar aws apply died at the cluster with "Cannot find version 16.6 for aurora-postgresql".
// It surfaced only on the weekly full-bar run because the weekday floor provisions no data services.
//
// It is a FULL minor, not a bare major, even though the gcp and azure templates pin bare majors:
// AWS's own DescribeOrderableDBInstanceOptions rejects "16" with "Engine version is not a valid full
// version". 16.8 is the lowest still-offered plain 16.x, and the offered set is identical across
// us-east-1, eu-central-1, eu-west-1 and us-west-2 — one pin serves every region.
//
// Two guards keep it honest, and they catch different things:
//   - TestAuroraVersionCouplings (this package) fails when a .tf copy drifts from this constant.
//     Runs on every PR, needs no cloud.
//   - .github/workflows/catalog-drift.yml re-derives what AWS actually offers each month and files an
//     issue when a shipped version is withdrawn. Only that one can catch the next retirement.
const DefaultAuroraPostgresVersion = "16.8"

type awsProvider struct{}

func (p *awsProvider) Name() string { return "aws" }

func (p *awsProvider) RequiredCLIs() []string {
	// CLI-free: the runner mints the EKS token in-process (kube-token exec-plugin), so
	// aws-iam-authenticator is no longer required. Only cluster tooling remains.
	return []string{"kubectl", "helm"}
}

func (p *awsProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	enableKarpenter := false
	if v, ok := config.Cluster.ProviderConfig["enable_karpenter"]; ok {
		if b, ok := v.(bool); ok {
			enableKarpenter = b
		}
	}

	// The canvas's two DNS switches seed these; an explicitly-set provider_config key below still
	// overrides, so the documented escape hatch keeps working in both directions (#1810).
	//
	// `waf_enabled` drives the REGIONAL web ACL, not the CloudFront one: no template creates an
	// aws_cloudfront_* resource, so a CLOUDFRONT-scoped ACL could never be attached to anything.
	// cloudfront_waf stays reachable through provider_config for anyone fronting their own
	// distribution.
	cloudfrontWaf := false
	acmCert := config.DNS.ManagedCertificate
	appWaf := config.DNS.WafEnabled
	if v, ok := config.DNS.ProviderConfig["cloudfront_waf"]; ok {
		if b, ok := v.(bool); ok {
			cloudfrontWaf = b
		}
	}
	if v, ok := config.DNS.ProviderConfig["acm_certificate"]; ok {
		if b, ok := v.(bool); ok {
			acmCert = b
		}
	}
	if v, ok := config.DNS.ProviderConfig["application_waf"]; ok {
		if b, ok := v.(bool); ok {
			appWaf = b
		}
	}

	provisionVPC := config.Network.ProvisionNetwork
	if !provisionVPC && config.Network.NetworkID == "" {
		provisionVPC = true
	}

	ecrNames := buildECRNamesMap(config)

	tfvars := map[string]interface{}{
		"project_name":   config.ProjectName,
		"region":         resolveRegion("aws", config.Region),
		"environment":    config.EnvironmentStage,
		"aws_account_id": config.CloudAccountID,

		// VPC
		"provision_vpc":          provisionVPC,
		"vpc_cidr":               orDefault(config.Network.CIDRBlock, "10.0.0.0/16"),
		"vpc_single_nat_gateway": config.Network.SingleNatGateway,

		// EKS
		"eks_cluster_version": resolveK8sVersion("aws", config.Cluster.ClusterVersion),
		"enable_karpenter":    enableKarpenter,
		"eks_cluster_admins":  ensureSlice(config.Cluster.ClusterAdmins),

		// DNS / WAF
		"dns_hosted_zone": config.DNS.ZoneID,
		"dns_main_domain": config.DNS.DomainName,
		// Create the Route 53 zone in-template (parity with GCP/Azure) only when DNS is
		// enabled AND the caller did not bring an existing zone id.
		"cloud_dns_enabled":             config.DNS.Enabled && config.DNS.ZoneID == "",
		"acm_certificate_enable":        acmCert,
		"cloudfront_waf_enabled":        cloudfrontWaf,
		"application_waf_enabled":       appWaf,
		"waf_webacl_cloudwatch_enabled": false,
		"waf_sampled_requests_enabled":  false,
		"waf_logging_enabled":           false,
		"waf_log_retention_days":        90,

		// SQS/SNS
		"provision_sqs": len(config.Queues) > 0 || len(config.Topics) > 0,
		"sqs_queues":    buildSQSQueues(config.Queues, config.Topics),
		"sns_topics":    buildSNSTopics(config.Topics),

		// Cache defaults. The chosen ENGINE decides which module runs — the Caches block below
		// overrides both toggles. Defaulting Redis on keeps an engine-less config unchanged.
		"create_elasticache_redis":         len(config.Caches) > 0,
		"create_elasticache_valkey":        false,
		"redis_cluster_size":               1,
		"redis_cluster_mode_enabled":       false,
		"redis_instance_type":              "cache.t3.micro",
		"redis_engine_version":             "7.1",
		"redis_family":                     "redis7",
		"redis_allowed_cidr_blocks":        []string{},
		"redis_allowed_security_group_ids": []string{},
		"redis_cloudwatch_logs_enabled":    false,

		// Secrets
		"custom_secrets": buildSecrets(config.Secrets),

		// DynamoDB
		"ddb_create":                     len(config.NosqlTables) > 0,
		"ddb_global_create":              hasGlobalTables(config.NosqlTables),
		"ddb_table_configuration":        buildDDBTables(config.NosqlTables, "standard"),
		"ddb_global_table_configuration": buildDDBTables(config.NosqlTables, "global"),

		// S3
		"s3_create":            len(config.StorageBuckets) > 0,
		"bucket_configuration": buildS3Buckets(config.StorageBuckets),

		// ECR (container registry). ecr_names_map drives the module's for_each — one repo per
		// native registry component + one per repo-sourced service (the W2 build destination).
		// It used to stay {} (only the boolean was emitted), so `local.ecr_input` resolved
		// empty and NOTHING was ever created even with provision_ecr=true.
		"provision_ecr": len(ecrNames) > 0,
		"ecr_names_map": ecrNames,

		// RDS
		"create_rds": len(config.Databases) > 0,
	}

	if len(config.Databases) > 0 {
		db := config.Databases[0]
		scalingConfig := map[string]interface{}{"min_capacity": 0.5, "max_capacity": 4.0}
		if db.MinCapacity != nil {
			scalingConfig["min_capacity"] = *db.MinCapacity
		}
		if db.MaxCapacity != nil {
			scalingConfig["max_capacity"] = *db.MaxCapacity
		}
		tfvars["rds_scaling_config"] = scalingConfig
		engine, version := resolveDBEngine("aws", db)
		engine = orDefault(engine, "aurora-postgresql")
		version = orDefault(version, DefaultAuroraPostgresVersion)
		// Engine-aware composition (#1504). Everything below must follow the RESOLVED engine — the
		// template's defaults are all Aurora-PostgreSQL-shaped, so an aurora-mysql engine that only
		// set engine/version would get a Postgres parameter-group family, port 5432 and the
		// "postgresql" log export: a MySQL cluster that never comes up.
		defaultPort := 5432
		if awsIsMySQLEngine(engine) {
			defaultPort = 3306
		}
		rdsConfig := map[string]interface{}{
			"engine":         engine,
			"engine_version": version,
			"db_port":        derefIntOr(db.Port, defaultPort),
			"db_name":        db.Name,
		}
		// Omitted (not blanked) when underivable, so the template default stands and the
		// family-matches-engine check decides — never emit a family we can't justify.
		if family := awsAuroraFamily(engine, version); family != "" {
			rdsConfig["cluster_family"] = family
		}
		tfvars["rds_config"] = rdsConfig
		tfvars["rds_logs_exports"] = awsRDSLogExports(engine, db.ProviderConfig)
		if db.InstanceClass != "" {
			tfvars["rds_instance_type"] = db.InstanceClass
		}
		if db.BackupRetentionDays != nil {
			tfvars["rds_backup_retention_period"] = *db.BackupRetentionDays
		}
		if db.IamAuth != nil {
			tfvars["rds_iam_auth_enabled"] = *db.IamAuth
			// Keyless parity (#722): one iam_auth toggle drives BOTH the RDS engine flag and the app
			// IRSA role the keyless workload assumes (rds_iam_auth_irsa_arn) — otherwise enabling IAM
			// auth would produce a DB that accepts tokens but no identity able to mint one.
			tfvars["rds_iam_irsa"] = *db.IamAuth
		}
		// Generic passthrough for knobs with no typed field. `log_exports` is reserved because it is
		// consumed above under a different tfvar name; the two IAM-auth flags are reserved
		// UNCONDITIONALLY (not merely merge-if-absent) so keyless can never be switched on from
		// provider_config for a cell the canvas did not offer — db.IamAuth == nil leaves them unset,
		// and without this a passthrough key would sail past both #1508 and #1510.
		mergeProviderConfig(tfvars, db.ProviderConfig,
			"log_exports", "rds_iam_auth_enabled", "rds_iam_irsa")
	}

	if len(config.Caches) > 0 {
		cache := config.Caches[0]

		// The engine the user picked decides WHICH ElastiCache module runs. #1415 stopped a Valkey
		// version corrupting the Redis config and left the toggle wiring as an explicit follow-up;
		// this is that follow-up. Anything not explicitly Valkey stays Redis, so an engine-less
		// config (an older project, the CLI's minimal shape) builds exactly what it built before.
		valkey := cache.Engine == types.CacheEngineValkey
		tfvars["create_elasticache_valkey"] = valkey
		tfvars["create_elasticache_redis"] = !valkey

		if valkey {
			// Serverless: sized by usage limits, not a node type. MemoryGB is the cloud-indifferent
			// size the canvas collects and maps to the storage ceiling directly (both GB).
			//
			// NumCacheNodes / MultiAz have no serverless analogue — capacity and AZ spread are the
			// service's job — so they are deliberately NOT translated, rather than mapped onto
			// something that merely looks equivalent.
			if cache.MemoryGB > 0 {
				tfvars["valkey_data_storage_max"] = cache.MemoryGB
			}
			if cache.EngineVersion != "" {
				tfvars["valkey_engine_version"] = cache.EngineVersion
			}
		} else {
			tfvars["redis_instance_type"] = orDefault(
				resolveCacheNodeType("aws", cache),
				"cache.t3.medium",
			)
			if cache.EngineVersion != "" {
				tfvars["redis_engine_version"] = cache.EngineVersion
				// Keep the parameter-group FAMILY in lock-step with the version — ElastiCache rejects
				// a version whose major doesn't match `family` ("6.2" under "redis7"). Now that the
				// version is a real picker (#977) this is easy to trip. (#1415)
				if fam := awsRedisFamily(cache.EngineVersion); fam != "" {
					tfvars["redis_family"] = fam
				}
			}
			if cache.NumCacheNodes != nil {
				tfvars["redis_cluster_size"] = *cache.NumCacheNodes
			}
			if cache.MultiAz != nil {
				tfvars["redis_multi_az_enabled"] = *cache.MultiAz
			}
		}
	}

	if inst := resolveInstanceTypes("aws", config.Cluster); len(inst) > 0 {
		tfvars["eks_instance_types"] = inst
	}
	if config.Cluster.NodeMinSize > 0 {
		tfvars["eks_ng_min_size"] = config.Cluster.NodeMinSize
	}
	if config.Cluster.NodeMaxSize > 0 {
		tfvars["eks_ng_max_size"] = config.Cluster.NodeMaxSize
	}
	if config.Cluster.NodeDesiredSize > 0 {
		tfvars["eks_ng_desired_size"] = config.Cluster.NodeDesiredSize
	}
	if config.Cluster.NodeDiskSizeGB != nil {
		tfvars["eks_disk_size"] = *config.Cluster.NodeDiskSizeGB
	}

	// Generic passthrough: any provider_config key that names a template variable
	// flows through verbatim (e.g. eks_volume_iops, a CMEK key id, WAF rule list)
	// without a dedicated Go field. Reserved keys are consumed above under a
	// different tfvar name, so they aren't injected as undeclared duplicates.
	// B1.2: classification → resource tags (+ the always-on project-id/environment-id sweep
	// handles), AWS-styled (`alethia:...`). Set before mergeProviderConfig so a user's
	// provider_config can't shadow it. Consumed by the template's classification_tags var (B1.3).
	tfvars["classification_tags"] = classificationTags(config, awsTagStyle)

	mergeProviderConfig(tfvars, config.Cluster.ProviderConfig, "enable_karpenter")
	mergeProviderConfig(tfvars, config.DNS.ProviderConfig, "cloudfront_waf", "acm_certificate", "application_waf")

	return tfvars
}

// mergeProviderConfig copies template-variable overrides from a component's
// provider_config JSONB into the flat tfvars map, WITHOUT clobbering keys already
// set by the typed mappings (merge-if-absent). This is the generic "passthrough"
// that lets the UI drive any template variable by name without a dedicated Go field
// per knob. `reserved` lists provider_config keys the typed code already consumed
// under a different tfvar name, so they are skipped (no undeclared-var duplicates).
func mergeProviderConfig(tfvars map[string]interface{}, pc map[string]any, reserved ...string) {
	if len(pc) == 0 {
		return
	}
	skip := make(map[string]bool, len(reserved))
	for _, r := range reserved {
		skip[r] = true
	}
	for k, v := range pc {
		if skip[k] {
			continue
		}
		if _, exists := tfvars[k]; !exists {
			tfvars[k] = v
		}
	}
}

func ensureSlice(s []interface{}) []interface{} {
	if s == nil {
		return []interface{}{}
	}
	return s
}

func orDefault(val, def string) string {
	if val != "" {
		return val
	}
	return def
}

// ddbCapacityMode translates the cloud-neutral capacity mode (on_demand /
// provisioned) to the DynamoDB-style value the IaC templates expect. Defaults to
// on-demand for empty/unknown input.
func ddbCapacityMode(mode string) string {
	if mode == "provisioned" {
		return "PROVISIONED"
	}
	return "PAY_PER_REQUEST"
}

// providerInt reads an int from a provider_config JSONB map (JSON numbers
// decode as float64). Returns false when absent or non-numeric.
func providerInt(cfg map[string]any, key string) (int, bool) {
	if cfg == nil {
		return 0, false
	}
	switch v := cfg[key].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

// awsRedisFamily derives the ElastiCache parameter-group family ("redis7", "redis6", …) from a Redis
// engine version, so a picked version and the `redis_family` var never disagree. Returns "" for an
// unparseable version, leaving the base default untouched. (#977)
func awsRedisFamily(version string) string {
	major, _, _ := strings.Cut(version, ".")
	if major == "" {
		return ""
	}
	return "redis" + major
}

// awsIsMySQLEngine reports whether a resolved AWS database engine is MySQL-family. Matches the
// catalog value ("aurora-mysql") as well as a legacy hand-set Engine ("mysql"), since resolveDBEngine
// passes the latter through untouched.
func awsIsMySQLEngine(engine string) bool {
	return strings.Contains(strings.ToLower(engine), "mysql")
}

// awsAuroraFamily derives the Aurora DB cluster parameter-group family from the resolved engine +
// version, so a picked engine and the `cluster_family` var can never disagree — the #1382-class trap
// where the canvas offers Aurora MySQL but the tfvars compose it onto the `aurora-postgresql16`
// default, mis-provisioning the cluster.
//
// The two engines name their families DIFFERENTLY, which is the whole reason this can't be one
// sprintf: AWS uses MAJOR.MINOR for Aurora MySQL ("aurora-mysql8.0", "aurora-mysql8.4") but MAJOR
// only for Aurora PostgreSQL ("aurora-postgresql16"). Verified against the AWS Aurora User Guide
// (custom-parameter-group tutorial: "For Parameter group family, choose aurora-mysql8.0").
//
// Returns "" when the version can't yield a valid family (e.g. a MySQL version with no minor), which
// leaves the template default in place. That is safe because the template's
// terraform_data.rds_engine_shape_guard precondition then BLOCKS the apply — a `check` block alone
// would only warn. Never guess a family: a wrong one provisions a cluster that cannot serve.
func awsAuroraFamily(engine, version string) string {
	major, rest, hasMinor := strings.Cut(version, ".")
	if major == "" {
		return ""
	}
	switch {
	case awsIsMySQLEngine(engine):
		minor, _, _ := strings.Cut(rest, ".")
		if !hasMinor || minor == "" {
			return ""
		}
		return "aurora-mysql" + major + "." + minor
	case strings.Contains(strings.ToLower(engine), "postgres"):
		return "aurora-postgresql" + major
	}
	return ""
}

// awsRDSLogExports returns the CloudWatch log-export set for the engine, honouring an explicit
// provider_config `log_exports` when the tenant set one. Aurora MySQL rejects "postgresql" (and vice
// versa), so the DEFAULT must follow the engine or `tofu apply` fails at the cluster.
//
// An explicit set is passed through verbatim, NOT sanitized against the engine: RDS-ENGINE-003
// (checks_data.tf) already blocks an engine-invalid set fail-closed at apply, naming the valid types,
// and silently dropping an entry would hide what the tenant actually asked for.
//
// `general` is absent from the MySQL default on purpose. The MySQL general log records every
// statement with its literal parameter values, so defaulting it on ships whatever the application put
// in a WHERE clause to the customer's CloudWatch, plus the ingest bill. `audit` covers the
// security-forensics case without the statement text; anyone who wants full query logging opts in.
func awsRDSLogExports(engine string, pc map[string]any) []string {
	if v, ok := providerStringSlice(pc, "log_exports"); ok {
		return v
	}
	if awsIsMySQLEngine(engine) {
		return []string{"audit", "error", "slowquery"}
	}
	return []string{"postgresql"}
}

// providerStringSlice reads a []string from a provider_config key. JSON round-trips arrays as
// []any of string, so both that and a native []string are accepted. An explicitly EMPTY list is a
// real choice ("export nothing") and is returned as such, distinct from an absent key.
func providerStringSlice(cfg map[string]any, key string) ([]string, bool) {
	if cfg == nil {
		return nil, false
	}
	switch v := cfg[key].(type) {
	case []string:
		return v, true
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			s, ok := e.(string)
			if !ok {
				return nil, false // a non-string entry makes the whole list untrustworthy
			}
			out = append(out, s)
		}
		return out, true
	}
	return nil, false
}

// s3SSEAlgorithm resolves the S3 server-side-encryption algorithm from the
// bucket's provider_config (encryption_algorithm), defaulting to AES256 when
// encryption is enabled.
func s3SSEAlgorithm(b types.ProjectStorageBucketConfig) string {
	if b.ProviderConfig != nil {
		if v, ok := b.ProviderConfig["encryption_algorithm"].(string); ok && v != "" {
			return v
		}
	}
	return "AES256"
}

func derefIntOr(p *int, def int) int {
	if p != nil {
		return *p
	}
	return def
}

// derefBoolOr resolves an optional canvas switch to a concrete value. An unset switch is the OFF
// position, not "leave the key out": a tri-state that sometimes omits a key produces a tfvars shape
// that differs between two projects with the same visible configuration, and a template argument
// then falls back to a default nobody chose.
func derefBoolOr(p *bool, def bool) bool {
	if p != nil {
		return *p
	}
	return def
}

// buildSQSQueues maps each canvas queue onto one entry of the `sqs_queues` tfvar.
//
// Ordered delivery is SQS FIFO, and FIFO is not one argument: `fifo_queue` decides it, the queue's
// name must then end in `.fifo`, and the queue's dead-letter queue must be FIFO too (AWS rejects a
// standard DLQ on a FIFO queue). The template owns the name and the DLQ, so what is carried here is
// the decision — `fifo_queue` — plus `content_based_deduplication`, without which every SendMessage
// to a FIFO queue must carry its own MessageDeduplicationId or fail.
//
// `content_based_deduplication` follows `fifo_queue` rather than standing on its own switch: SQS
// refuses it on a standard queue, so the two can never be set independently from one canvas
// boolean.
func buildSQSQueues(queues []types.ProjectQueueConfig, topics []types.ProjectTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, q := range queues {
		ordered := derefBoolOr(q.Ordered, false)
		cfg := map[string]interface{}{
			"fifo_queue":                  ordered,
			"content_based_deduplication": ordered,
			"dlq_enable":                  false,
		}
		if q.VisibilityTimeout != nil {
			cfg["visibility_timeout_seconds"] = *q.VisibilityTimeout
		}
		if q.MessageRetention != nil {
			cfg["message_retention_seconds"] = *q.MessageRetention
		}
		if d, ok := providerInt(q.ProviderConfig, "delay_seconds"); ok {
			cfg["delay_seconds"] = d
		}
		result[q.Name] = cfg
	}
	return result
}

func buildSNSTopics(topics []types.ProjectTopicConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for _, t := range topics {
		subs := []map[string]string{}
		for _, s := range t.Subscriptions {
			subs = append(subs, map[string]string{
				"protocol": string(s.Protocol),
				"endpoint": s.Endpoint,
			})
		}
		result[t.Name] = map[string]interface{}{
			"subscriptions": subs,
		}
	}
	return result
}

func (p *awsProvider) ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error {
	// BYO-IaC: if the module emitted a ready-made generic `kubeconfig` output, write it
	// directly. This supports a self-managed / non-EKS cluster on AWS whose name EKS does
	// not own — DescribeCluster below would 404 for it. Managed EKS emits no `kubeconfig`
	// output and so falls through to the DescribeCluster path unchanged.
	if kc := extractOutputString(outputs, "kubeconfig"); kc != "" {
		fmt.Fprintf(stdout, "Writing BYO kubeconfig from tofu outputs...\n")
		return writeRawKubeconfig(kc, stdout)
	}

	clusterName := ExtractClusterName(outputs)
	if clusterName == "" {
		return fmt.Errorf("no EKS cluster name in outputs")
	}
	fmt.Fprintf(stdout, "Configuring kubeconfig for EKS cluster %s...\n", clusterName)

	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(config.Region))
	if err != nil {
		return fmt.Errorf("failed to load AWS config: %w", err)
	}
	// Safely resolve endpoint/CA/ARN — ErrClusterNotReady (not a nil-deref panic) when the cluster
	// isn't ACTIVE yet, e.g. kubeconfig requested moments after provisioning.
	conn, err := coreaws.ResolveEKSClusterConn(ctx, eks.NewFromConfig(cfg), clusterName)
	if err != nil {
		return err
	}
	// CLI-free: the kubeconfig authenticates via the runner's own `kube-token` exec-plugin
	// (in-process presigned STS token, x-k8s-aws-id bound to this cluster) instead of the
	// aws-iam-authenticator binary. Endpoint + CA come from DescribeCluster.
	return writeExecKubeconfig(
		conn.ARN,
		conn.Endpoint,
		conn.CAData,
		[]string{"kube-token", "--provider", "aws", "--cluster", clusterName, "--region", config.Region},
		stdout,
	)
}

// buildECRNamesMap collects the ECR repositories the template must create, keyed by the
// component's logical name — the SAME key the `ecr_repository_urls_map` output uses, so
// BUILD (#588) and the manifest renderer (#589) can look up a service's push destination
// by its service name. One entry per native container-registry component + one per
// repo-sourced service (the W2 build destination). Values are repo base names; the ecr
// module prefixes them with "<project_name>-".
func buildECRNamesMap(config *types.ProjectConfig) map[string]string {
	out := map[string]string{}
	for _, r := range config.ContainerRegistries {
		// Pluggable non-native registries (connectors.slug) are not ECR's to create.
		if r.Provider != "" && r.Provider != "native" {
			continue
		}
		if base := ecrRepoBaseName(r.Name); base != "" {
			out[r.Name] = base
		}
	}
	for _, s := range config.Services {
		if s.Source.Kind != "repo" {
			continue
		}
		if base := ecrRepoBaseName(s.Name); base != "" {
			out[s.Name] = base
		}
	}
	return out
}

// ecrRepoBaseName normalizes a component name into a valid ECR repository base name
// (lowercase alphanumerics with single "-" separators) — deterministic, so re-planning a
// project always addresses the same repository.
func ecrRepoBaseName(name string) string {
	var b strings.Builder
	pendingSep := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			if pendingSep && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			pendingSep = false
		default:
			// Any separator/invalid run collapses to one "-" (never leading/trailing).
			pendingSep = true
		}
	}
	return b.String()
}

func buildSecrets(secrets []types.ProjectSecretConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(secrets))
	for _, s := range secrets {
		if !secretProvisionedNatively(s.Provider) {
			continue // read via ESO from its pluggable/cross-account store, not created here
		}
		entry := map[string]interface{}{
			"secret_name": s.Name,
		}
		if s.Generate {
			entry["length"] = s.Length
			entry["special"] = s.SpecialChars
		} else {
			entry["manual"] = true
		}
		result = append(result, entry)
	}
	return result
}

func hasGlobalTables(tables []types.ProjectNosqlConfig) bool {
	for _, t := range tables {
		if t.TableType == "global" {
			return true
		}
	}
	return false
}

func buildDDBTables(tables []types.ProjectNosqlConfig, tableType string) []map[string]interface{} {
	result := []map[string]interface{}{}
	for _, t := range tables {
		if string(t.TableType) != tableType {
			continue
		}
		entry := map[string]interface{}{
			"table_name_suffix":             t.Name,
			"hash_key":                      t.PartitionKey,
			"hash_key_type":                 orDefault(string(t.PartitionKeyType), "S"),
			"range_key":                     t.SortKey,
			"range_key_type":                orDefault(string(t.SortKeyType), "S"),
			"billing_mode":                  ddbCapacityMode(string(t.CapacityMode)),
			"enable_point_in_time_recovery": t.PointInTimeRecovery,
		}
		result = append(result, entry)
	}
	return result
}

func buildS3Buckets(buckets []types.ProjectStorageBucketConfig) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(buckets))
	for _, b := range buckets {
		blockPublic := !b.PublicAccess
		cors := []map[string]interface{}{}
		if len(b.CorsOrigins) > 0 {
			cors = append(cors, map[string]interface{}{
				"allowed_headers": []string{"*"},
				"allowed_methods": []string{"GET", "PUT", "POST"},
				"allowed_origins": b.CorsOrigins,
				"expose_headers":  []string{},
				"max_age_seconds": 3600,
			})
		}
		result = append(result, map[string]interface{}{
			"bucket_name_suffix":      b.Name,
			"acl_type":                "private",
			"create_s3_user":          false,
			"versioning_enabled":      b.Versioning,
			"sse_algorithm":           s3SSEAlgorithm(b),
			"store_access_key_in_ssm": false,
			"block_public_acls":       blockPublic,
			"block_public_policy":     blockPublic,
			"ignore_public_acls":      blockPublic,
			"restrict_public_buckets": blockPublic,
			"cors_configuration":      cors,
		})
	}
	return result
}

var _ CloudProvider = (*awsProvider)(nil)
