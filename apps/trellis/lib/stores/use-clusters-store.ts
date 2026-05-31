import { createClient } from "@/lib/supabase/client";
import { create } from "zustand";

export interface ClusterData {
	vine_id: string;
	project_name: string;
	environment_stage: string;
	region: string;
	status: string;
	cluster_name: string | null;
	cluster_endpoint: string | null;
	cluster_version: string | null;
	dns_domain: string | null;
	databases: Array<{
		name: string;
		engine: string;
		endpoint: string | null;
		status: string;
	}>;
	caches: Array<{
		name: string;
		engine: string;
		endpoint: string | null;
		status: string;
	}>;
}

interface ClustersStore {
	clusters: ClusterData[];
	isLoading: boolean;
	fetchClusters: () => Promise<void>;
}

export const useClustersStore = create<ClustersStore>((set) => ({
	clusters: [],
	isLoading: true,

	fetchClusters: async () => {
		const supabase = createClient();

		const { data: vines } = await supabase
			.from("vines")
			.select("id, project_name, environment_stage, region, status")
			.eq("status", "ACTIVE")
			.order("created_at", { ascending: false });

		if (!vines || vines.length === 0) {
			set({ clusters: [], isLoading: false });
			return;
		}

		const vineIds = vines.map((v) => v.id);

		const [clusterRes, dbRes, cacheRes, dnsRes] = await Promise.all([
			supabase
				.from("vine_cluster")
				.select("vine_id, cluster_name, cluster_endpoint, cluster_version")
				.in("vine_id", vineIds),
			supabase
				.from("vine_databases")
				.select("vine_id, name, engine, endpoint, status")
				.in("vine_id", vineIds),
			supabase
				.from("vine_caches")
				.select("vine_id, name, engine, endpoint, status")
				.in("vine_id", vineIds),
			supabase
				.from("vine_dns")
				.select("vine_id, domain_name")
				.in("vine_id", vineIds)
				.eq("enabled", true),
		]);

		const clusterMap = new Map(
			(clusterRes.data || []).map((c) => [c.vine_id, c]),
		);
		const dnsMap = new Map(
			(dnsRes.data || []).map((d) => [d.vine_id, d.domain_name]),
		);

		const clusters: ClusterData[] = vines.map((vine) => {
			const cluster = clusterMap.get(vine.id);
			return {
				vine_id: vine.id,
				project_name: vine.project_name,
				environment_stage: vine.environment_stage,
				region: vine.region,
				status: vine.status,
				cluster_name: cluster?.cluster_name || null,
				cluster_endpoint: cluster?.cluster_endpoint || null,
				cluster_version: cluster?.cluster_version || null,
				dns_domain: dnsMap.get(vine.id) || null,
				databases: (dbRes.data || [])
					.filter((d) => d.vine_id === vine.id)
					.map((d) => ({
						name: d.name,
						engine: d.engine || "",
						endpoint: d.endpoint,
						status: d.status,
					})),
				caches: (cacheRes.data || [])
					.filter((c) => c.vine_id === vine.id)
					.map((c) => ({
						name: c.name,
						engine: c.engine || "",
						endpoint: c.endpoint,
						status: c.status,
					})),
			};
		});

		set({ clusters, isLoading: false });
	},
}));
