// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "@/lib/cloud-providers";

/**
 * The canvas context the client sends with each Ask AI request: the core cloud
 * provider + the current graph projected to the ProjectFormData shape (from
 * `graphToForm`). Kept loose — the route reads it defensively.
 */
export interface CanvasContext {
	provider: CloudProviderSlug;
	form: Record<string, unknown>;
	/** Current nodes (id · kind · name) so the model can target set_identity/update_config. */
	nodes?: Array<{ id: string; kind: string; name?: string }>;
}

/** A compact, model-friendly summary of the current canvas for the system prompt. */
export function summarizeCanvas(ctx: CanvasContext | undefined): string {
	if (!ctx) return "The canvas is empty.";
	const f = ctx.form ?? {};
	const project = (f.project as Record<string, unknown>) ?? {};
	const arr = (k: string) => (Array.isArray(f[k]) ? (f[k] as unknown[]) : []);
	const named = (k: string) =>
		arr(k)
			.map((x) => (x as { name?: string }).name)
			.filter(Boolean)
			.join(", ");

	const lines = [
		`Core cloud provider: ${ctx.provider}`,
		`Project: ${(project.project_name as string) || "(unnamed)"} · region ${
			(project.region as string) || "(unset)"
		} · ${(project.environment_stage as string) || "development"}`,
		`Cluster: ${f.cluster ? "present" : "none"} · Network: ${
			f.network ? "present" : "none"
		} · DNS: ${(f.dns as { enabled?: boolean })?.enabled ? "on" : "off"}`,
		`Databases: [${named("databases")}]`,
		`Caches: [${named("caches")}]`,
		`Queues: [${named("queues")}]  Topics: [${named("topics")}]`,
		`NoSQL: [${named("nosql_tables")}]  Secrets: [${named("secrets")}]`,
	];

	if (ctx.nodes?.length) {
		lines.push("Nodes (id · kind · name) — target these ids for set_identity/update_config:");
		for (const n of ctx.nodes) {
			lines.push(`  - ${n.id} · ${n.kind}${n.name ? ` · ${n.name}` : ""}`);
		}
	}
	return lines.join("\n");
}
