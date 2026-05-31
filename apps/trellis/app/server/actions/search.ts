"use server";

import { createClient } from "@/lib/supabase/server";

export interface SearchResult {
	type: "vine" | "vineyard" | "job" | "integration";
	id: string;
	title: string;
	subtitle: string;
	href: string;
}

/** Searches across vines, vineyards, jobs, and integrations. Returns max 10 results. */
export async function globalSearch(query: string): Promise<SearchResult[]> {
	if (!query || query.trim().length < 2) return [];

	const supabase = await createClient();
	const q = `%${query.trim().toLowerCase()}%`;
	const results: SearchResult[] = [];

	const [vines, vineyards, jobs] = await Promise.all([
		supabase
			.from("vines")
			.select("id, project_name, environment_stage, region")
			.ilike("project_name", q)
			.limit(4),
		supabase
			.from("vineyards")
			.select("id, name, description")
			.ilike("name", q)
			.limit(3),
		supabase
			.from("provision_jobs")
			.select("id, job_type, status, created_at")
			.or(`id.ilike.${q}`)
			.order("created_at", { ascending: false })
			.limit(3),
	]);

	if (vines.data) {
		for (const v of vines.data) {
			results.push({
				type: "vine",
				id: v.id,
				title: v.project_name,
				subtitle: `${v.environment_stage} · ${v.region}`,
				href: `/dashboard/vineyards?vine_id=${v.id}`,
			});
		}
	}

	if (vineyards.data) {
		for (const vy of vineyards.data) {
			results.push({
				type: "vineyard",
				id: vy.id,
				title: vy.name,
				subtitle: vy.description || "Vineyard",
				href: `/dashboard/vineyards/${vy.id}`,
			});
		}
	}

	if (jobs.data) {
		for (const j of jobs.data) {
			results.push({
				type: "job",
				id: j.id,
				title: `${j.job_type.replace("_", " ")} — ${j.status.toLowerCase()}`,
				subtitle: j.id.slice(0, 8),
				href: `/dashboard/jobs?job_id=${j.id}`,
			});
		}
	}

	return results.slice(0, 10);
}
