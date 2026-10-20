// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113: the topic → key map the real-time bus (#6115) invalidates through. The jobs topic must
// cover every jobs read on the router, or a live job change would leave a page stale — every one but
// those `JOBS_NOT_ON_TOPIC` names with their own live source (#6121: the log head).

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { orpc } from "@/lib/rpc/client";
import { JOBS_NOT_ON_TOPIC, TOPIC_KEYS } from "@/lib/query/topics";
import { procedurePaths } from "@/lib/rpc/procedure-paths";
import { router } from "@/lib/rpc/router";
import { qk } from "@/lib/query/keys";
import { TOPICS } from "@/lib/realtime/topics";

describe("TOPIC_KEYS", () => {
	it("invalidates every jobs.page read, whatever its input", async () => {
		const client = new QueryClient();
		// Copied into plain arrays: the cache only cares about the key's VALUE, and the typed key would
		// demand a full page payload the invalidation under test never reads.
		const a: unknown[] = [...orpc.jobs.page.queryKey({ input: { range: { preset: "7d" } } })];
		const b: unknown[] = [...orpc.jobs.page.queryKey({ input: { range: { preset: "12mo" }, statuses: ["FAILED"] } })];
		client.setQueryData(a, { rows: [] });
		client.setQueryData(b, { rows: [] });
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
		expect(client.getQueryState(a)?.isInvalidated).toBe(true);
		expect(client.getQueryState(b)?.isInvalidated).toBe(true);
	});

	it("...and nothing outside the jobs domain", async () => {
		const client = new QueryClient();
		client.setQueryData(["projects", "acme"], []);
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
		expect(client.getQueryState(["projects", "acme"])?.isInvalidated).toBe(false);
	});

	it("#6128: organization invalidates the org's General settings and the workspace context (switcher, breadcrumb)", async () => {
		const client = new QueryClient();
		const settings: unknown[] = [...orpc.settings.org.queryKey()];
		const context: unknown[] = [...orpc.workspace.context.queryKey()];
		const projects: unknown[] = [...orpc.workspace.projects.queryKey()];
		client.setQueryData(settings, { scope: "personal" });
		client.setQueryData(context, {});
		client.setQueryData(projects, []);
		for (const queryKey of TOPIC_KEYS.organization()) await client.invalidateQueries({ queryKey });
		expect(client.getQueryState(settings)?.isInvalidated).toBe(true);
		expect(client.getQueryState(context)?.isInvalidated).toBe(true);
		expect(client.getQueryState(projects)?.isInvalidated).toBe(false);
	});

	it("#6128: projects invalidates the shell's list and every project's General settings read", async () => {
		const client = new QueryClient();
		const list: unknown[] = [...orpc.workspace.projects.queryKey()];
		const a: unknown[] = [...orpc.settings.project.queryKey({ input: { project: "shop" } })];
		const b: unknown[] = [...orpc.settings.project.queryKey({ input: { project: "api" } })];
		const org: unknown[] = [...orpc.settings.org.queryKey()];
		for (const key of [list, a, b, org]) client.setQueryData(key, null);
		for (const queryKey of TOPIC_KEYS.projects()) await client.invalidateQueries({ queryKey });
		for (const key of [list, a, b]) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		expect(client.getQueryState(org)?.isInvalidated).toBe(false);
	});

	it("lists exactly the topics the wire can carry (lib/realtime/topics.ts), empty until a lane moves its reads", () => {
		expect(Object.keys(TOPIC_KEYS).sort()).toEqual([...TOPICS].sort());
	});

	it("#6115: jobs also invalidates the legacy qk.jobs / qk.jobsPage / qk.job reads (still polled by #6114's hooks)", async () => {
		const client = new QueryClient();
		const legacy: unknown[][] = [
			[...qk.jobs("acme")],
			[...qk.jobsPage("acme", { status: "FAILED" })],
			[...qk.job("acme", "j1")],
			[...qk.jobStatus("acme", "j1")],
		];
		for (const key of legacy) client.setQueryData(key, {});
		client.setQueryData([...qk.runners("acme")], {});
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
		for (const key of legacy) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		expect(client.getQueryState([...qk.runners("acme")])?.isInvalidated).toBe(false);
	});

	it("#6121: a jobs hint refreshes a job's detail but not its log head (the log streams on its own)", async () => {
		const client = new QueryClient();
		const detail: unknown[] = [...orpc.jobs.detail.queryKey({ input: { id: "j1" } })];
		const head: unknown[] = [...orpc.jobs.logsHead.queryKey({ input: { id: "j1" } })];
		client.setQueryData(detail, {});
		client.setQueryData(head, { lines: [], lastId: 0 });
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
		expect(client.getQueryState(detail)?.isInvalidated).toBe(true);
		expect(client.getQueryState(head)?.isInvalidated).toBe(false);
	});

	it("#6121: every jobs procedure on the router is either refreshed by a jobs hint or named as not", async () => {
		const jobsProcedures = (await procedurePaths(router))
			.filter((path) => path.startsWith("jobs."))
			.map((path) => path.slice("jobs.".length));
		expect(jobsProcedures.length).toBeGreaterThan(0);
		const covered = new Set(TOPIC_KEYS.jobs().map((key) => JSON.stringify(key)));
		// oRPC's procedure key is `[path, {}]`. Built from the router's path rather than read off the
		// client proxy (which answers any property), and checked against the client for one procedure
		// so the two cannot drift.
		const keyOf = (name: string) => JSON.stringify([["jobs", name], {}]);
		expect(keyOf("page")).toBe(JSON.stringify(orpc.jobs.page.key()));
		const unaccounted = jobsProcedures.filter((name) => !(name in JOBS_NOT_ON_TOPIC) && !covered.has(keyOf(name)));
		expect(unaccounted).toEqual([]);
		// The exclusions name real procedures — a stale one would hide nothing and excuse nothing.
		expect(Object.keys(JOBS_NOT_ON_TOPIC).filter((name) => !jobsProcedures.includes(name))).toEqual([]);
	});
});
