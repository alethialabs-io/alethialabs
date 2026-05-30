"use server";

import { createClient } from "@/lib/supabase/server";
import { getValidProviderToken } from "./identities";
import type {
	PublicVineCachesInsert,
	PublicVineDatabasesInsert,
	PublicVineDnsInsert,
	PublicVineClusterInsert,
	PublicVineQueuesInsert,
	PublicVineRepositoriesInsert,
	PublicVinesInsert,
	PublicVineTopicsInsert,
	PublicVineNetworkInsert,
} from "@/lib/validations/db.schemas";

// ============================================================
// Types
// ============================================================

export interface CreateVineInput {
	vine: Omit<
		PublicVinesInsert,
		"user_id" | "status" | "created_at" | "updated_at"
	>;
	network: Omit<
		PublicVineNetworkInsert,
		| "vine_id"
		| "status"
		| "status_message"
		| "estimated_monthly_cost"
		| "created_at"
		| "updated_at"
	>;
	cluster: Omit<
		PublicVineClusterInsert,
		| "vine_id"
		| "status"
		| "status_message"
		| "estimated_monthly_cost"
		| "cluster_name"
		| "cluster_endpoint"
		| "created_at"
		| "updated_at"
	>;
	dns: Omit<
		PublicVineDnsInsert,
		| "vine_id"
		| "status"
		| "status_message"
		| "estimated_monthly_cost"
		| "created_at"
		| "updated_at"
	>;
	repositories: Omit<
		PublicVineRepositoriesInsert,
		"vine_id" | "created_at" | "updated_at"
	>;
	databases?: Omit<
		PublicVineDatabasesInsert,
		| "vine_id"
		| "status"
		| "status_message"
		| "estimated_monthly_cost"
		| "endpoint"
		| "reader_endpoint"
		| "created_at"
		| "updated_at"
	>[];
	caches?: Omit<
		PublicVineCachesInsert,
		| "vine_id"
		| "status"
		| "status_message"
		| "estimated_monthly_cost"
		| "endpoint"
		| "created_at"
		| "updated_at"
	>[];
	queues?: Omit<
		PublicVineQueuesInsert,
		| "vine_id"
		| "status"
		| "status_message"
		| "estimated_monthly_cost"
		| "created_at"
		| "updated_at"
	>[];
	topics?: Omit<
		PublicVineTopicsInsert,
		| "vine_id"
		| "status"
		| "status_message"
		| "estimated_monthly_cost"
		| "created_at"
		| "updated_at"
	>[];
}

// ============================================================
// Create
// ============================================================

export async function createVine(data: CreateVineInput) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	// 1. Insert vine
	const { data: vine, error: vineError } = await supabase
		.from("vines")
		.insert(data.vine as PublicVinesInsert)
		.select()
		.single();

	if (vineError || !vine) {
		throw new Error(
			"Failed to create vine: " + (vineError?.message || "unknown"),
		);
	}

	// 2. Insert singleton components
	const [networkRes, clusterRes, dnsRes, reposRes] = await Promise.all([
		supabase.from("vine_network").insert({ vine_id: vine.id, ...data.network }),
		supabase.from("vine_cluster").insert({ vine_id: vine.id, ...data.cluster } as PublicVineClusterInsert),
		supabase.from("vine_dns").insert({ vine_id: vine.id, ...data.dns } as PublicVineDnsInsert),
		supabase
			.from("vine_repositories")
			.insert({ vine_id: vine.id, ...data.repositories }),
	]);

	const singletonErrors = [
		networkRes.error,
		clusterRes.error,
		dnsRes.error,
		reposRes.error,
	].filter(Boolean);
	if (singletonErrors.length > 0) {
		await supabase.from("vines").delete().eq("id", vine.id);
		throw new Error(
			"Failed to create components: " +
				singletonErrors.map((e) => e!.message).join(", "),
		);
	}

	// 3. Insert multi-instance components
	if (data.databases && data.databases.length > 0) {
		const { error } = await supabase
			.from("vine_databases")
			.insert(data.databases.map((db) => ({ vine_id: vine.id, ...db })));
		if (error)
			throw new Error("Failed to create databases: " + error.message);
	}

	if (data.caches && data.caches.length > 0) {
		const { error } = await supabase
			.from("vine_caches")
			.insert(data.caches.map((c) => ({ vine_id: vine.id, ...c })));
		if (error) throw new Error("Failed to create caches: " + error.message);
	}

	if (data.queues && data.queues.length > 0) {
		const { error } = await supabase
			.from("vine_queues")
			.insert(data.queues.map((q) => ({ vine_id: vine.id, ...q })));
		if (error) throw new Error("Failed to create queues: " + error.message);
	}

	if (data.topics && data.topics.length > 0) {
		const { error } = await supabase
			.from("vine_topics")
			.insert(data.topics.map((t) => ({ vine_id: vine.id, ...t })));
		if (error) throw new Error("Failed to create topics: " + error.message);
	}

	// 4. Audit log
	await supabase.from("vine_audit_log").insert({
		vine_id: vine.id,
		action: "CREATED",
		changes: {
			project_name: data.vine.project_name,
			environment: data.vine.environment_stage,
		},
	});

	return { vine };
}

// ============================================================
// Read
// ============================================================

export async function getVines() {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("vines")
		.select("*")
		.order("created_at", { ascending: false });

	if (error) throw new Error("Failed to fetch vines: " + error.message);
	return { vines: data };
}

export async function getVine(vineId: string) {
	const supabase = await createClient();

	const [
		vine,
		network,
		cluster,
		dns,
		repos,
		databases,
		caches,
		queues,
		topics,
		nosqlTables,
		secrets,
	] = await Promise.all([
		supabase.from("vines").select("*").eq("id", vineId).single(),
		supabase
			.from("vine_network")
			.select("*")
			.eq("vine_id", vineId)
			.maybeSingle(),
		supabase
			.from("vine_cluster")
			.select("*")
			.eq("vine_id", vineId)
			.maybeSingle(),
		supabase
			.from("vine_dns")
			.select("*")
			.eq("vine_id", vineId)
			.maybeSingle(),
		supabase
			.from("vine_repositories")
			.select("*")
			.eq("vine_id", vineId)
			.maybeSingle(),
		supabase
			.from("vine_databases")
			.select("*")
			.eq("vine_id", vineId)
			.order("created_at"),
		supabase
			.from("vine_caches")
			.select("*")
			.eq("vine_id", vineId)
			.order("created_at"),
		supabase
			.from("vine_queues")
			.select("*")
			.eq("vine_id", vineId)
			.order("created_at"),
		supabase
			.from("vine_topics")
			.select("*")
			.eq("vine_id", vineId)
			.order("created_at"),
		supabase
			.from("vine_nosql_tables")
			.select("*")
			.eq("vine_id", vineId)
			.order("created_at"),
		supabase
			.from("vine_secrets")
			.select("*")
			.eq("vine_id", vineId)
			.order("created_at"),
	]);

	if (vine.error || !vine.data) throw new Error("Vine not found");

	return {
		vine: vine.data,
		components: {
			network: network.data,
			cluster: cluster.data,
			dns: dns.data,
			repositories: repos.data,
			databases: databases.data || [],
			caches: caches.data || [],
			queues: queues.data || [],
			topics: topics.data || [],
			nosql_tables: nosqlTables.data || [],
			secrets: secrets.data || [],
		},
	};
}

// ============================================================
// Provision
// ============================================================

async function buildConfigSnapshot(vineId: string) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");

	const { data: vine, error: vineError } = await supabase
		.from("vines")
		.select("*")
		.eq("id", vineId)
		.single();

	if (vineError || !vine) throw new Error("Vine not found");

	const { data: identity } = await supabase
		.from("cloud_identities")
		.select("id")
		.eq("provider", "aws")
		.eq("is_verified", true)
		.maybeSingle();

	if (!identity) {
		throw new Error(
			"No verified AWS account connected. Go to Integrations to connect.",
		);
	}

	const [network, cluster, dns, repos, databases, caches, queues, topics] =
		await Promise.all([
			supabase
				.from("vine_network")
				.select("*")
				.eq("vine_id", vineId)
				.maybeSingle(),
			supabase
				.from("vine_cluster")
				.select("*")
				.eq("vine_id", vineId)
				.maybeSingle(),
			supabase
				.from("vine_dns")
				.select("*")
				.eq("vine_id", vineId)
				.maybeSingle(),
			supabase
				.from("vine_repositories")
				.select("*")
				.eq("vine_id", vineId)
				.maybeSingle(),
			supabase.from("vine_databases").select("*").eq("vine_id", vineId),
			supabase.from("vine_caches").select("*").eq("vine_id", vineId),
			supabase.from("vine_queues").select("*").eq("vine_id", vineId),
			supabase.from("vine_topics").select("*").eq("vine_id", vineId),
		]);

	const clusterConfig = cluster.data?.provider_config;
	const dnsConfig = dns.data?.provider_config;

	const configSnapshot = {
		...vine,
		create_vpc: network.data?.provision_network ?? true,
		vpc_cidr: network.data?.cidr_block ?? "10.0.0.0/16",
		enable_karpenter: clusterConfig?.enable_karpenter ?? true,
		cluster_version: cluster.data?.cluster_version,
		enable_dns: dns.data?.enabled ?? false,
		dns_main_domain: dns.data?.domain_name,
		dns_hosted_zone: dns.data?.zone_id,
		cloudfront_waf_enabled: dnsConfig?.cloudfront_waf ?? false,
		acm_certificate_enable: dnsConfig?.acm_certificate ?? false,
		env_template_repo: repos.data?.env_template_repo,
		env_template_repo_branch: repos.data?.env_template_branch,
		env_git_repo: repos.data?.env_destination_repo,
		gitops_template_repo: repos.data?.gitops_template_repo,
		gitops_template_repo_branch: repos.data?.gitops_template_branch,
		gitops_destination_repo: repos.data?.gitops_destination_repo,
		applications_template_repo: repos.data?.apps_template_repo,
		applications_template_repo_branch: repos.data?.apps_template_branch,
		applications_destination_repo: repos.data?.apps_destination_repo,
		databases: databases.data || [],
		caches: caches.data || [],
		queues: queues.data || [],
		topics: topics.data || [],
	};

	const repoUrl =
		repos.data?.env_destination_repo ||
		repos.data?.gitops_destination_repo ||
		"";
	const gitProvider = repoUrl.includes("gitlab")
		? "gitlab"
		: repoUrl.includes("bitbucket")
			? "bitbucket"
			: "github";
	const gitToken = await getValidProviderToken(gitProvider);

	return {
		user,
		vine,
		identity,
		configSnapshot: {
			...configSnapshot,
			git_access_token: gitToken,
		},
	};
}

export async function planVine(vineId: string) {
	const supabase = await createClient();
	const { user, vine, identity, configSnapshot } =
		await buildConfigSnapshot(vineId);

	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			vine_id: vineId,
			vineyard_id: vine.vineyard_id || null,
			cloud_identity_id: identity.id,
			job_type: "PLAN" as any,
			config_snapshot: configSnapshot,
			status: "QUEUED",
		})
		.select("id")
		.single();

	if (jobError)
		throw new Error("Failed to queue plan job: " + jobError.message);

	return { jobId: job.id };
}

export async function provisionVine(vineId: string, planJobId?: string) {
	const supabase = await createClient();
	const { user, vine, identity, configSnapshot } =
		await buildConfigSnapshot(vineId);

	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			vine_id: vineId,
			vineyard_id: vine.vineyard_id || null,
			cloud_identity_id: identity.id,
			job_type: "DEPLOY",
			config_snapshot: configSnapshot,
			status: "QUEUED",
			...(planJobId ? { plan_job_id: planJobId } : {}),
		} as any)
		.select("id")
		.single();

	if (jobError)
		throw new Error("Failed to queue provision job: " + jobError.message);

	await supabase.from("vines").update({ status: "QUEUED" }).eq("id", vineId);

	await supabase.from("vine_audit_log").insert({
		vine_id: vineId,
		action: "PROVISIONED",
		changes: { job_id: job.id },
	});

	return { jobId: job.id };
}

// ============================================================
// Delete
// ============================================================

export async function deleteVine(vineId: string) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");

	// CASCADE handles all component tables
	const { error } = await supabase.from("vines").delete().eq("id", vineId);
	if (error) throw new Error("Failed to delete vine: " + error.message);

	return { success: true };
}
