// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The real-model paths with no browser journey of their own, driven over the console's own HTTP
// surface (written for the AI soak, epic #7840, lane #7839). Runs in the `elench-live` project:
// nightly at Haiku, and on a PR that changes these paths (e2e-ai-nightly.yml on the PR, until 2026-12-12).
//
// · REPO-SCAN INFERENCE. `inferStack` (lib/scanner/infer.ts, `generateObject`) runs when the Configure
//   screen reads `projects.scanProposal` for a finished ANALYZE_REPO job — the same read
//   `/{org}/~/new?scan=<job>` prefetches. A live repo plus a runner is not available in CI, so the job
//   is seeded with the digest a runner would have written, and the read is made over the read router
//   (`/{org}/~/rpc/projects/scanProposal`, oRPC's RPC protocol: a GET whose `data` parameter is the
//   serialized input, answered `{ json: <output> }`). That IS the production path from the digest on:
//   the route, the actor, the jobs visibility rule, the model call, the schema and the metering.
//   (`getMergedScanProposal`, the multi-repo variant, calls the same `inferStack`; it is a server
//   action and is not reachable from a test without the page's action id.)
//
// · AGENT-IDENTITY TURNS. `/api/agent/[agentId]` runs a turn AS an `agent_identities` row, on the turn
//   claim. There is no UI for it, so the turn is POSTed with the body the Elench transport sends.
//
// · COLONY. `runColonyTasks` had no caller and was deleted in the same change (#7839), so there is
//   nothing of it left to soak.
//
// Assertions are behaviour, never wording: a schema-valid stack with at least one entry, a stream that
// finishes without an error chunk and calls the one tool the identity is scoped to, and — on a metered
// console — a settled, priced ledger row that names the scan job or the identity's thread.

import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { z } from "zod";
import { inferredStackSchema } from "@/lib/scanner/schema";
import type { RepoDigest } from "@/types/jsonb.types";
import { STORAGE_STATE } from "./fixtures/auth";
import { outstandingHolds, personaOrgSlug, personaOwner, seedAiTier, soakTier } from "./helpers/ai-tier";
import { db } from "./helpers/db";
import { seedCloudIdentity, seedProject, type SeededProject } from "./helpers/seed";

test.skip(!process.env.ANTHROPIC_API_KEY, "needs a real ANTHROPIC_API_KEY on the console under test");

test.setTimeout(240_000);

/** Whether this console meters AI usage into the ledger (see ai-live-agent.spec.ts `METERED`). */
const METERED = Boolean(process.env.STRIPE_SECRET_KEY);

/**
 * A small, fixed repo digest in the shape the runner writes (`RepoDigest`,
 * packages/core/types/repo_digest.go): a Node service with a Postgres client and a Redis client in its
 * manifest, a Dockerfile, and the env example that names both. Enough evidence that a correct
 * inference names at least one backing service; small enough to cost a few thousand tokens.
 */
const DIGEST: RepoDigest = {
	repo_url: "https://github.com/alethia-e2e/soak-shop",
	ref: "main",
	scanned_at: "2026-11-27T00:00:00Z",
	file_count: 4,
	languages: { ".ts": 12, ".json": 2 },
	signals: ["postgres", "redis"],
	manifests: [
		{
			path: "package.json",
			content: JSON.stringify({
				name: "soak-shop",
				scripts: { start: "node dist/server.js" },
				dependencies: { express: "^4.19.2", pg: "^8.12.0", ioredis: "^5.4.1" },
			}),
		},
	],
	dockerfiles: [
		{
			path: "Dockerfile",
			content: "FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nEXPOSE 3000\nCMD [\"npm\",\"start\"]\n",
		},
	],
	env_examples: [
		{
			path: ".env.example",
			content: "DATABASE_URL=postgres://user:pass@localhost:5432/shop\nREDIS_URL=redis://localhost:6379\nPORT=3000\n",
		},
	],
};

let slug = "";
let owner: { orgId: string; userId: string };
let project: SeededProject;

/** The settled ledger rows that name `refId` (a scan's job id, or an agent turn's thread id). */
async function settledRowsFor(refId: string): Promise<{ kind: string; model: string | null; costMicros: number }[]> {
	return db()<{ kind: string; model: string | null; costMicros: number }[]>`
		select kind, model, coalesce(cost_micros, 0)::bigint::float8 as "costMicros"
		from ai_usage_ledger
		where org_id = ${owner.orgId} and ref_id = ${refId} and settled_at is not null`;
}

/**
 * Read one procedure of the console's read router as the browser's oRPC link does: a GET to
 * `/{org}/~/rpc/<path>` with the serialized input in `data`. Answers the procedure's output.
 */
async function rpcRead(request: APIRequestContext, path: string, input: unknown): Promise<unknown> {
	const data = encodeURIComponent(JSON.stringify({ json: input, meta: [] }));
	const res = await request.get(`/${slug}/~/rpc/${path}?data=${data}`, { timeout: 180_000 });
	const text = await res.text();
	expect(res.status(), `GET ${path} answered ${res.status()}: ${text.slice(0, 500)}`).toBe(200);
	const body: unknown = JSON.parse(text);
	return typeof body === "object" && body !== null && "json" in body ? body.json : body;
}

test.describe(`real-model API paths · ${soakTier()}`, () => {
	test.beforeAll(async ({ browser }, testInfo) => {
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			baseURL: testInfo.project.use.baseURL,
		});
		const page = await context.newPage();
		slug = await personaOrgSlug(page);
		await seedAiTier(slug);
		owner = await personaOwner(slug);
		project = await seedProject(owner, { name: `soak-api-${Date.now()}` });
		await context.close();
	});

	test("a scanned repo's digest is inferred into a schema-valid stack (inferStack)", async ({ page }) => {
		// The proposal places the project on the caller's first verified account; with none, the read
		// answers NEEDS_SETUP and the stack is not returned. Give the persona one.
		await seedCloudIdentity(owner, { provider: "aws", name: `soak-scan-${Date.now()}` });
		const sql = db();
		const [job] = await sql<{ id: string }[]>`
			insert into jobs ${sql({
				user_id: owner.userId,
				org_id: owner.orgId,
				job_type: "ANALYZE_REPO",
				status: "SUCCESS",
				provider: "aws",
				config_snapshot: sql.json({ repo_url: DIGEST.repo_url, ref: DIGEST.ref ?? "main" }),
				execution_metadata: sql.json({ repo_digest: JSON.parse(JSON.stringify(DIGEST)) }),
				completed_at: new Date(),
			})}
			returning id`;
		if (!job) throw new Error("the scan job was not seeded");

		await page.goto(`/${slug}`);
		const result = await rpcRead(page.request, "projects/scanProposal", { jobId: job.id });
		const ready = z
			.object({ status: z.literal("READY"), proposal: z.object({ stack: inferredStackSchema }) })
			.safeParse(result);
		expect(ready.success, `the proposal is READY with a schema-valid stack: ${JSON.stringify(result).slice(0, 800)}`).toBe(true);
		if (!ready.success) return;
		const { stack } = ready.data.proposal;
		expect(stack.runtime.trim().length, "the stack names a runtime").toBeGreaterThan(0);
		expect(stack.needs.length, "the stack names at least one backing service").toBeGreaterThan(0);

		if (METERED) {
			await expect
				.poll(async () => (await settledRowsFor(job.id)).filter((r) => r.kind === "scan" && r.model !== null).length, {
					timeout: 30_000,
				})
				.toBeGreaterThan(0);
			for (const r of await settledRowsFor(job.id)) {
				expect(r.costMicros, `the scan row for ${r.model} carries a cost`).toBeGreaterThan(0);
			}
		}
	});

	test("a turn run AS an agent identity streams, uses only its scoped tool, and is metered on its thread", async ({ page }) => {
		const sql = db();
		const [identity] = await sql<{ id: string }[]>`
			insert into agent_identities ${sql({
				user_id: owner.userId,
				org_id: owner.orgId,
				project_id: project.projectId,
				persona: "You are the soak auditor, a terse read-only assistant for one Alethia project.",
				mission: "Answer questions about the user's projects using only the tools you are granted.",
				tool_scope: sql.json(["list_projects"]),
				memory_namespace: `soak/${randomUUID()}`,
			})}
			returning id`;
		if (!identity) throw new Error("the agent identity was not seeded");

		const threadId = randomUUID();
		const turnId = `soak-${Date.now()}`;
		await page.goto(`/${slug}`);
		const res = await page.request.post(`/api/agent/${identity.id}`, {
			timeout: 200_000,
			data: {
				threadId,
				orgId: owner.orgId,
				mode: "ask",
				// A thread the route has never seen is created under this id at revision 1 (turn-claims.ts
				// `lockThread`), so a first turn's transcript base is 1.
				turn: { trigger: "submit-message", turnId, baseRevision: 1 },
				messages: [
					{
						id: turnId,
						role: "user",
						parts: [{ type: "text", text: "Which projects do I have? Use your tool, then answer in one sentence." }],
					},
				],
			},
		});
		const body = await res.text();
		expect(res.status(), `the agent route answered ${res.status()}: ${body.slice(0, 500)}`).toBe(200);

		// The UI message stream is SSE: one `data: {json}` chunk per event.
		const chunks = body
			.split("\n")
			.filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
			.map((l): unknown => JSON.parse(l.slice("data: ".length)));
		const typed = chunks.filter((c): c is { type: string; toolName?: string; errorText?: string } =>
			typeof c === "object" && c !== null && "type" in c && typeof c.type === "string",
		);
		const errors = typed.filter((c) => c.type === "error");
		expect(errors, `the stream carried an error: ${JSON.stringify(errors)}`).toHaveLength(0);
		expect(typed.some((c) => c.type === "text-delta"), "the answer streamed text").toBe(true);
		expect(typed.some((c) => c.type === "finish"), "the stream finished").toBe(true);
		const tools = new Set(typed.filter((c) => c.type === "tool-input-available").map((c) => c.toolName));
		expect([...tools], "the identity called its one scoped tool").toContain("list_projects");
		expect([...tools].filter((t) => t !== "list_projects"), "no tool outside the identity's scope ran").toHaveLength(0);

		// The thread the turn ran on is the identity's project's — what per-project AI usage attributes
		// the turn's ledger rows by (ai-quota.ts: an agent row's ref_id → agent_threads.project_id).
		const threads = await db()<{ projectId: string | null }[]>`
			select project_id as "projectId" from agent_threads where id = ${threadId}`;
		expect(threads[0]?.projectId, "the turn's thread belongs to the identity's project").toBe(project.projectId);

		if (METERED) {
			await expect
				.poll(async () => (await settledRowsFor(threadId)).filter((r) => r.kind === "agent" && r.model !== null).length, {
					timeout: 30_000,
				})
				.toBeGreaterThan(0);
			for (const r of await settledRowsFor(threadId)) {
				expect(r.costMicros, `the agent row for ${r.model} carries a cost`).toBeGreaterThan(0);
			}
			// A hold row carries no ref_id until it is reconciled, so this reads the org's holds: CI runs
			// one worker, so nothing else is mid-turn for this org now.
			await expect.poll(() => outstandingHolds(owner.orgId), { timeout: 30_000 }).toBe(0);
		}
	});
});
