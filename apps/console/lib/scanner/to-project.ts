// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import { DB_ENGINES, DEFAULT_REGION, type CloudProviderSlug } from "@/lib/cloud-providers";
import { type ProjectFormData, projectFormSchema } from "@/lib/validations/project-form.schema";
import type { InferredNeed, InferredStack } from "./schema";

const SERVICE_KINDS: InferredNeed["kind"][] = [
	"database",
	"cache",
	"queue",
	"topic",
	"nosql",
	"secret",
];

/** Slug → `[a-z0-9-]`, start alnum, ≤25 (the project project_name regex). */
function slugify(name: string, fallback = "app"): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/-+$/, "");
	return s.slice(0, 25) || fallback;
}

function repoName(url: string): string {
	return url.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "app";
}

/** Pick a valid DB engine option for the provider from a generic engine hint. */
function dbEngine(provider: CloudProviderSlug, hint?: string) {
	const opts = DB_ENGINES[provider];
	const picked = /mysql|maria/i.test(hint ?? "")
		? opts.find((o) => /mysql/.test(o.value))
		: opts.find((o) => /postgres/.test(o.value));
	return picked ?? opts[0];
}

/**
 * Deterministically map an InferredStack onto a guaranteed-valid ProjectFormData:
 * clone the canonical `NODE_REGISTRY[kind].defaultData(provider)` for each need +
 * overlay engine/name, set the required project roots, and ASSERT `projectFormSchema`
 * passes. CORE component identities are left to inherit the project's (placement gate
 * passes). The model can never produce an invalid project — this code does.
 */
export function inferredStackToFormData(
	stack: InferredStack,
	opts: {
		identityId: string;
		provider: CloudProviderSlug;
		repoUrl: string;
		region?: string;
	},
): ProjectFormData {
	const { provider } = opts;
	const dd = (k: NodeKind): Record<string, unknown> => ({
		...NODE_REGISTRY[k].defaultData(provider),
	});

	const byKind: Record<string, Record<string, unknown>[]> = {
		database: [],
		cache: [],
		queue: [],
		topic: [],
		nosql: [],
		secret: [],
	};
	const counts: Record<string, number> = {};

	for (const need of stack.needs) {
		if (!SERVICE_KINDS.includes(need.kind)) continue;
		const cfg = dd(need.kind);
		counts[need.kind] = (counts[need.kind] ?? 0) + 1;
		const baseName = typeof cfg.name === "string" ? cfg.name : need.kind;
		cfg.name = need.name
			? slugify(need.name, baseName)
			: counts[need.kind] > 1
				? `${baseName}-${counts[need.kind]}`
				: baseName;
		if (need.kind === "database") {
			const eng = dbEngine(provider, need.engine);
			cfg.engine = eng.value;
			cfg.engine_version = eng.defaultVersion;
		}
		byKind[need.kind].push(cfg);
	}

	const candidate = {
		project: {
			project_name: slugify(repoName(opts.repoUrl)),
			environment_stage: "development",
			region: opts.region || DEFAULT_REGION[provider],
			cloud_identity_id: opts.identityId,
			iac_version: "1.11.4",
		},
		network: dd("network"),
		cluster: dd("cluster"),
		dns: { ...dd("dns"), enabled: false },
		repositories: { apps_destination_repo: opts.repoUrl },
		databases: byKind.database,
		caches: byKind.cache,
		queues: byKind.queue,
		topics: byKind.topic,
		nosql_tables: byKind.nosql,
		secrets: byKind.secret,
	};

	const parsed = projectFormSchema.safeParse(candidate);
	if (!parsed.success) {
		throw new Error(`Scanner produced an invalid project: ${parsed.error.message}`);
	}
	return parsed.data;
}
