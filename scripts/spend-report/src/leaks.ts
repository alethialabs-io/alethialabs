// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudId, Leak } from "./types";

/**
 * Which e2e run a resource belongs to, by the SAME rule the sweepers use — a port of
 * `e2e_scope_attribute` in scripts/e2e/lib/scope-key.sh, not a new selector. The two handles:
 *
 *   project-id  `alethia:project-id` (`alethia_project-id` on label clouds) starting `e2e-` — every
 *               stack a seeded run created. Wins when present.
 *   e2e-run     `alethia:e2e-run` matching EXACTLY `e2e-<run_id>-<attempt>` — the only handle a
 *               CLI-created (cli-demo) stack carries. Stricter, because any org can define that
 *               classification dimension; a customer value that merely starts `e2e-` is not a run.
 *
 * tests/leaks.test.ts replays scope-key.sh's own self-test cases against this port, so the two cannot
 * drift apart without a red test.
 */
export function e2eScopeAttribute(
	projectId: string | undefined,
	e2eRun: string | undefined,
): { handle: string; key: "project-id" | "e2e-run" } | null {
	const pid = projectId ?? "";
	if (/^e2e-.+/.test(pid)) return { handle: pid, key: "project-id" };
	const run = e2eRun ?? "";
	if (/^e2e-[0-9]+-[0-9]+$/.test(run)) return { handle: run, key: "e2e-run" };
	return null;
}

/** One row of `resourcegroupstaggingapi get-resources` output. */
interface TagMapping {
	ResourceARN?: string;
	Tags?: { Key?: string; Value?: string }[];
}

/** The AWS resource type from an ARN (`ec2:vpc`, `eks:cluster`). */
export function arnKind(arn: string): string {
	const parts = arn.split(":");
	const service = parts[2] ?? "?";
	const resource = parts.slice(5).join(":");
	const type = resource.includes("/") ? resource.split("/")[0] : resource.split(":")[0];
	return type ? `${service}:${type}` : service;
}

/** Turns get-resources mappings into leaks, deduplicated by ARN. */
export function awsLeaksFromMappings(mappings: TagMapping[]): Leak[] {
	const seen = new Map<string, Leak>();
	for (const m of mappings) {
		const arn = m.ResourceARN;
		if (!arn || seen.has(arn)) continue;
		const tag = (k: string) => m.Tags?.find((t) => t.Key === k)?.Value;
		const attr = e2eScopeAttribute(tag("alethia:project-id"), tag("alethia:e2e-run"));
		if (!attr) continue;
		seen.set(arn, { cloud: "aws", id: arn, kind: arnKind(arn), ...attr });
	}
	return [...seen.values()];
}

/** A labelled hcloud resource, as every hcloud list endpoint returns it. */
export interface HcloudLabelled {
	id: number | string;
	name?: string;
	labels?: Record<string, string>;
}

/** Turns hcloud resources of one kind into leaks, by the `alethia_*` label handles. */
export function hcloudLeaks(kind: string, resources: HcloudLabelled[]): Leak[] {
	const out: Leak[] = [];
	for (const r of resources) {
		const attr = e2eScopeAttribute(r.labels?.["alethia_project-id"], r.labels?.["alethia_e2e-run"]);
		if (!attr) continue;
		out.push({ cloud: "hetzner", id: `${kind}/${r.id}${r.name ? ` (${r.name})` : ""}`, kind, ...attr });
	}
	return out;
}

/** Groups leaks by cloud + handle, for a compact listing. */
export function groupLeaks(leaks: Leak[]): { cloud: CloudId; handle: string; count: number; kinds: string[]; ids: string[] }[] {
	const groups = new Map<string, { cloud: CloudId; handle: string; count: number; kinds: Set<string>; ids: string[] }>();
	for (const l of leaks) {
		const k = `${l.cloud}\u0000${l.handle}`;
		const g = groups.get(k) ?? { cloud: l.cloud, handle: l.handle, count: 0, kinds: new Set<string>(), ids: [] };
		g.count += 1;
		g.kinds.add(l.kind);
		g.ids.push(l.id);
		groups.set(k, g);
	}
	return [...groups.values()]
		.map((g) => ({ ...g, kinds: [...g.kinds].sort() }))
		.sort((a, b) => a.cloud.localeCompare(b.cloud) || a.handle.localeCompare(b.handle));
}
