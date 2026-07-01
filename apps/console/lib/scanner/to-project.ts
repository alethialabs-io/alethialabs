// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import { DB_ENGINES, DEFAULT_REGION, type CloudProviderSlug } from "@/lib/cloud-providers";
import { slugify } from "@/lib/slug";
import { type ProjectFormData, projectFormSchema } from "@/lib/validations/project-form.schema";
import type { DetectedService } from "@/types/jsonb.types";
import type { InferredNeed, InferredStack } from "./schema";

const SERVICE_KINDS: InferredNeed["kind"][] = [
	"database",
	"cache",
	"queue",
	"topic",
	"nosql",
	"secret",
];

/** One scanned repo's inference result, for merging into a single project. */
export interface ScanInput {
	stack: InferredStack;
	repoUrl: string;
	ref?: string;
	/** Monorepo-aware services detected in the repo (carried onto the source repo row). */
	services?: DetectedService[];
}

/** Canonical slug capped at 25 chars (component/project names stay short), with a
 *  non-empty fallback when the name slugifies away entirely. */
function shortSlug(name: string, fallback = "app"): string {
	return slugify(name, 25) || fallback;
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
 * Collapse the backing needs of ONE OR MORE inferred stacks into per-kind component
 * configs, cloning the canonical `NODE_REGISTRY[kind].defaultData(provider)` and
 * overlaying engine/name. Every need becomes a component; names are made unique within
 * a kind (a count suffix for unnamed defaults, a collision suffix otherwise) so merging
 * repos never violates the `(project, environment, name)` constraint at insert.
 */
function collectComponents(
	needs: InferredNeed[],
	provider: CloudProviderSlug,
): Record<InferredNeed["kind"], Record<string, unknown>[]> {
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
	const seen: Record<string, Set<string>> = {
		database: new Set(),
		cache: new Set(),
		queue: new Set(),
		topic: new Set(),
		nosql: new Set(),
		secret: new Set(),
	};

	for (const need of needs) {
		if (!SERVICE_KINDS.includes(need.kind)) continue;
		const cfg = dd(need.kind);
		const baseName = typeof cfg.name === "string" ? cfg.name : need.kind;
		counts[need.kind] = (counts[need.kind] ?? 0) + 1;
		let name = need.name
			? shortSlug(need.name, baseName)
			: counts[need.kind] > 1
				? `${baseName}-${counts[need.kind]}`
				: baseName;
		// Guarantee uniqueness within the kind (across merged repos).
		if (seen[need.kind].has(name)) {
			let i = 2;
			while (seen[need.kind].has(`${name}-${i}`)) i++;
			name = `${name}-${i}`;
		}
		seen[need.kind].add(name);
		cfg.name = name;
		if (need.kind === "database") {
			const eng = dbEngine(provider, need.engine);
			cfg.engine = eng.value;
			cfg.engine_version = eng.defaultVersion;
		}
		byKind[need.kind].push(cfg);
	}
	return byKind as Record<InferredNeed["kind"], Record<string, unknown>[]>;
}

/**
 * Merge one or more scanned repos into a single, guaranteed-valid ProjectFormData:
 * union the backing needs (de-duped), attach every repo as a `source_repos` row (with
 * its detected services), set the project roots, and ASSERT `projectFormSchema` passes.
 * The first repo seeds the project name + the GitOps destination. The model can never
 * produce an invalid project — this code does.
 */
export function mergeScansToFormData(
	inputs: ScanInput[],
	opts: { identityId: string; provider: CloudProviderSlug; region?: string },
): ProjectFormData {
	const { provider } = opts;
	if (inputs.length === 0) throw new Error("mergeScansToFormData: no scan inputs");
	const dd = (k: NodeKind): Record<string, unknown> => ({
		...NODE_REGISTRY[k].defaultData(provider),
	});

	const byKind = collectComponents(
		inputs.flatMap((i) => i.stack.needs),
		provider,
	);
	const primary = inputs[0];

	const candidate = {
		project: {
			project_name: shortSlug(repoName(primary.repoUrl)),
			environment_stage: "development",
			region: opts.region || DEFAULT_REGION[provider],
			cloud_identity_id: opts.identityId,
			iac_version: "1.11.4",
		},
		network: dd("network"),
		cluster: dd("cluster"),
		dns: { ...dd("dns"), enabled: false },
		// The single GitOps destination (Phase C generates/points manifests here).
		repositories: { apps_destination_repo: primary.repoUrl },
		// Every scanned repo (1:N), carrying its monorepo services.
		source_repos: inputs.map((i) => ({
			repo_url: i.repoUrl,
			ref: i.ref ?? null,
			scan_path: "",
			services: i.services ?? [],
		})),
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

/**
 * Single-repo convenience over {@link mergeScansToFormData} — kept for the one-repo
 * scan path. `services` (monorepo detection) is optional.
 */
export function inferredStackToFormData(
	stack: InferredStack,
	opts: {
		identityId: string;
		provider: CloudProviderSlug;
		repoUrl: string;
		ref?: string;
		region?: string;
		services?: DetectedService[];
	},
): ProjectFormData {
	return mergeScansToFormData(
		[{ stack, repoUrl: opts.repoUrl, ref: opts.ref, services: opts.services }],
		opts,
	);
}
