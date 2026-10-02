// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The AI tool-scope denylist (#5281; lib/ai/tools/registry.ts AI_TOOL_DENIED_MODULES), enforced on
// the IMPORT GRAPH rather than on tool names.
//
// A tool can be called anything, so a name check alone is a check on a rendering. What an agent can
// DO is bounded by what its code can reach, so this walks every import, transitively, from every
// agent entry point — lib/ai/**, lib/agent/**, and every API route that imports either — and fails
// if any file on the way is a denied module. It resolves `@/` and relative specifiers to files on
// disk (.ts/.tsx, or a directory's index); package imports are not followed (no denied module lives
// in a package).
//
// Two checks keep it from passing by measuring nothing:
//   - every denied prefix must match at least one real file (a prefix that matches nothing denies
//     nothing, and silently stays green after a rename);
//   - the walker must FIND a denied module when one is genuinely reachable: walked from the mint
//     request route itself, it must reach lib/kubeconfig-mint/.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	AI_TOOL_DENIED_MODULES,
	assertAudienceCoverage,
	isDeniedToolName,
	isExternalTool,
	TOOL_AUDIENCE,
} from "@/lib/ai/tools/registry";

const ROOT = resolve(__dirname, "../..");

/** Every .ts/.tsx file under `dir` (console-root-relative), recursively. */
function filesUnder(dir: string): string[] {
	const abs = join(ROOT, dir);
	if (!existsSync(abs)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(abs)) {
		const rel = join(dir, entry);
		if (statSync(join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel));
		else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(rel);
	}
	return out;
}

/** Module specifiers a source file imports or re-exports (static, side-effect and dynamic). */
function specifiers(source: string): string[] {
	const out: string[] = [];
	const patterns = [
		/\bfrom\s+["']([^"']+)["']/g,
		/\bimport\s+["']([^"']+)["']/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const re of patterns) {
		for (const m of source.matchAll(re)) out.push(m[1]);
	}
	return out;
}

/** Resolves a specifier from `fromFile` to a console-root-relative file, or null (a package). */
function resolveSpecifier(fromFile: string, spec: string): string | null {
	let base: string;
	if (spec.startsWith("@/")) base = spec.slice(2);
	else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
	else return null;
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		join(base, "index.ts"),
		join(base, "index.tsx"),
	]) {
		const abs = join(ROOT, candidate);
		if (existsSync(abs) && statSync(abs).isFile() && /\.tsx?$/.test(candidate)) {
			return relative(ROOT, abs);
		}
	}
	return null;
}

/** Whether `file` lies under a denied prefix. */
function isDenied(file: string): boolean {
	return AI_TOOL_DENIED_MODULES.some((prefix) => file.startsWith(prefix));
}

/**
 * Walks the import graph from `roots`. Returns every denied file reached, each with the import chain
 * that reached it, and the number of files visited.
 */
function walk(roots: readonly string[]): { hits: string[][]; visited: Set<string> } {
	const visited = new Set<string>();
	const hits: string[][] = [];
	const queue: { file: string; chain: string[] }[] = roots.map((f) => ({ file: f, chain: [f] }));
	while (queue.length > 0) {
		const next = queue.shift();
		if (!next || visited.has(next.file)) continue;
		visited.add(next.file);
		const source = readFileSync(join(ROOT, next.file), "utf8");
		for (const spec of specifiers(source)) {
			const target = resolveSpecifier(next.file, spec);
			if (!target) continue;
			const chain = [...next.chain, target];
			if (isDenied(target)) hits.push(chain);
			else if (!visited.has(target)) queue.push({ file: target, chain });
		}
	}
	return { hits, visited };
}

/** Every agent entry point: the AI and agent libraries, and the API routes that import either. */
function agentRoots(): string[] {
	const libs = [...filesUnder("lib/ai"), ...filesUnder("lib/agent")];
	const routes = filesUnder("app/api").filter((f) =>
		/from\s+["']@\/lib\/(ai|agent)\//.test(readFileSync(join(ROOT, f), "utf8")),
	);
	return [...libs, ...routes];
}

describe("AI tool-scope denylist — the import graph", () => {
	it("no agent entry point reaches a denied module, transitively", () => {
		const roots = agentRoots();
		// The roots are real: the AI tool set and the MCP route are among them.
		expect(roots).toContain("lib/ai/tools/index.ts");
		expect(roots).toContain("app/api/mcp/route.ts");

		const { hits, visited } = walk(roots);
		// The walk went DEEP — through the tools into the server actions they call — so an empty
		// `hits` is a finding about the graph, not about a resolver that followed nothing.
		expect(visited.has("app/server/actions/projects.ts")).toBe(true);
		expect(visited.size).toBeGreaterThan(200);
		expect(hits.map((chain) => chain.join(" → "))).toEqual([]);
	});

	it("every denied prefix still names real files (a prefix that matches nothing denies nothing)", () => {
		// A directory prefix ends in `/`; a file prefix is matched among its directory's files.
		const empty = AI_TOOL_DENIED_MODULES.filter((prefix) => {
			const dir = prefix.endsWith("/") ? prefix.replace(/\/$/, "") : dirname(prefix);
			return !filesUnder(dir).some((f) => f.startsWith(prefix));
		});
		expect(empty).toEqual([]);
	});

	it("the walker finds a denied module when one IS reachable", () => {
		const { hits } = walk(["app/api/cli/clusters/[id]/kubeconfig/route.ts"]);
		expect(hits.some((chain) => chain.at(-1)?.startsWith("lib/kubeconfig-mint/"))).toBe(true);
	});

	it("the walker finds the console download from the cluster card (#5285)", () => {
		const { hits } = walk(["components/clusters/cluster-card.tsx"]);
		expect(
			hits.some((chain) => chain.at(-1)?.startsWith("components/clusters/kubeconfig-download/")),
		).toBe(true);
	});
});

describe("AI tool-scope denylist — tool names", () => {
	it.each(["mint_kubeconfig", "get_kubeconfig", "clusterKubeconfig", "KUBECONFIG"])(
		"refuses %s at the anti-drift check and from the external projection",
		(name) => {
			expect(isDeniedToolName(name)).toBe(true);
			expect(() => assertAudienceCoverage([name])).toThrow(/denylist/);
			expect(isExternalTool(name)).toBe(false);
		},
	);

	it("stays out of the external projection even if someone classifies it `both`", () => {
		TOOL_AUDIENCE.get_kubeconfig = "both";
		try {
			expect(isExternalTool("get_kubeconfig")).toBe(false);
		} finally {
			delete TOOL_AUDIENCE.get_kubeconfig;
		}
	});

	it("leaves the existing read tools alone", () => {
		expect(isDeniedToolName("list_clusters")).toBe(false);
		expect(isExternalTool("list_clusters")).toBe(true);
	});
});
