// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6128: the General settings reads, moved from server actions onto the read router (ADR 0005 D1).
//
// Mocked boundary: a thenable drizzle chain for the org row and the project row; the PDP stubbed.
// What is asserted beyond the moved behaviour (metadata parsing, defaults):
//   · the org read is the ACTOR's org — the address's — and asks the PDP's `view` first;
//   · the personal workspace is an explicit answer, not `null` (F050: `null` drew an endless
//     skeleton), and a missing org row is NOT_FOUND, not an empty form;
//   · the project read answers `null` for a slug that names nothing (the page's 404) and refuses a
//     project the PDP will not show as FORBIDDEN — through the router's typed refusals.

import { createRouterClient, ORPCError } from "@orpc/server";
import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// `org` feeds the service-role org read; `scoped` is a QUEUE — each RLS-scoped query, in the order
// the reader issues it, takes the next result (the project row, then the preview config, fabrics
// and credentials).
const { rows } = vi.hoisted(() => ({
	rows: { org: new Array<unknown>(), scoped: new Array<unknown[]>(), wheres: new Array<unknown>() },
}));

/** A drizzle-ish chain whose terminal (`limit`, `orderBy`, or a bare `await`) answers `result()`. */
function chain(result: () => unknown[]): unknown {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: (condition: unknown) => {
			rows.wheres.push(condition);
			return db;
		},
		limit: () => Promise.resolve(result()),
		orderBy: () => Promise.resolve(result()),
		then: (resolve: (v: unknown[]) => unknown) => resolve(result()),
	});
	return db;
}

vi.mock("@/lib/db", () => ({
	getServiceDb: () => chain(() => rows.org),
	withActorScope: async (_actor: unknown, fn: (tx: unknown) => unknown) =>
		fn(chain(() => rows.scoped.shift() ?? [])),
}));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));

import { authorize } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { readOrgGeneral, settingsRouter } from "@/lib/rpc/procedures/settings";

/** An actor in org `orgId` (personal when it equals the user). */
function actor(orgId: string): Actor {
	return { userId: "user-1", orgId, credential: "session" };
}

/** The router as the browser reaches it, for one actor. */
function client(as: Actor) {
	return createRouterClient(settingsRouter, { context: { actor: as } });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue(actor("org-1"));
	rows.org = [];
	rows.scoped = [];
	rows.wheres = [];
});

describe("settings.org", () => {
	it("answers the personal workspace as personal — never null, never an empty form", async () => {
		expect(await client(actor("user-1")).org()).toEqual({ scope: "personal" });
		expect(authorize).not.toHaveBeenCalled();
	});

	it("reads the ADDRESSED org after the PDP's view, and parses its metadata", async () => {
		rows.org = [
			{
				name: "Acme",
				slug: "acme",
				logo: null,
				metadata: JSON.stringify({
					description: "Our team",
					region: "us-east-1",
					defaultEnv: "production",
					terraformVersion: "1.10.0",
				}),
			},
		];
		const read = await client(actor("org-from-the-address")).org();
		expect(authorize).toHaveBeenCalledWith("view", { type: "org" });
		expect(read).toEqual({
			scope: "organization",
			settings: {
				name: "Acme",
				slug: "acme",
				logo: null,
				description: "Our team",
				primaryAddress: null,
				region: "us-east-1",
				defaultEnv: "production",
				terraformVersion: "1.10.0",
			},
		});
	});

	it("falls back to defaults when metadata is missing or malformed", async () => {
		rows.org = [{ name: "Acme", slug: "acme", logo: null, metadata: "{not json" }];
		expect(await readOrgGeneral(actor("org-1"))).toMatchObject({
			settings: { region: "eu-west-1", defaultEnv: "staging", terraformVersion: "1.9.5", description: "" },
		});
	});

	it("is NOT_FOUND when the org row is gone — a typed refusal, not empty data", async () => {
		const error = await client(actor("org-1"))
			.org()
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({ code: "NOT_FOUND", defined: true });
	});

	it("is FORBIDDEN when the PDP refuses view", async () => {
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("view", { type: "org" }));
		const error = await client(actor("org-1"))
			.org()
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "FORBIDDEN", defined: true });
	});
});

describe("settings.project", () => {
	const ROW = { id: "5f0c4b8e-2d1a-4c3b-9e7f-0a1b2c3d4e5f", project_name: "My App", slug: "my-app" };

	it("answers the project the slug names, after the PDP's view on it", async () => {
		rows.scoped = [[ROW]];
		expect(await client(actor("org-1")).project({ project: "my-app" })).toEqual(ROW);
		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: ROW.id });
	});

	// Review blocker on #6216: RLS admits two arms (`org_id = current_org OR org_id = current_owner`),
	// so inside an org the caller's PERSONAL projects are visible too. A same-slug personal project
	// could be the row the slug resolved to, and Rename/Delete would act on it. The lookup must name
	// the addressed org itself. (The DB-level proof is tests/integration/settings-project-scope.test.ts.)
	it("resolves the slug INSIDE the addressed org, not whatever RLS also lets the caller see", async () => {
		rows.scoped = [[ROW]];
		await client(actor("org-from-the-address")).project({ project: "my-app" });
		const [where] = rows.wheres;
		if (!is(where, SQL)) throw new Error("the project lookup passed no SQL condition");
		const rendered = new PgDialect().sqlToQuery(where);
		expect(rendered.sql).toMatch(/"projects"\."org_id" = \$\d/);
		expect(rendered.params).toContain("org-from-the-address");
		expect(rendered.params).toContain("my-app");
	});

	it("answers null for a slug that names no project in the org — the page's 404", async () => {
		expect(await client(actor("org-1")).project({ project: "gone" })).toBeNull();
		expect(authorize).not.toHaveBeenCalled();
	});

	it("is FORBIDDEN for a project the PDP will not show", async () => {
		rows.scoped = [[ROW]];
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("view", { type: "project", id: ROW.id }));
		const error = await client(actor("org-1"))
			.project({ project: "my-app" })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "FORBIDDEN", defined: true });
	});

	it("refuses an empty slug at the input", async () => {
		const error = await client(actor("org-1"))
			.project({ project: "" })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("settings.preview", () => {
	const ROW = { id: "5f0c4b8e-2d1a-4c3b-9e7f-0a1b2c3d4e5f", project_name: "Shop", slug: "shop" };
	const CONFIG = { id: "pc-1", project_id: ROW.id, enabled: true };
	const FABRIC = { id: "fab-1", name: "shared", region: "eu-west-1", status: "ACTIVE" };
	const CRED = { id: "cred-1", purpose: "argocd", method: "oauth" };

	it("answers the config, fabrics and credentials of the project the slug names, after its view", async () => {
		rows.scoped = [[ROW], [CONFIG], [FABRIC], [CRED]];
		expect(await client(actor("org-1")).preview({ project: "shop" })).toEqual({
			projectId: ROW.id,
			config: CONFIG,
			fabrics: [FABRIC],
			gitCredentials: [CRED],
		});
		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: ROW.id });
	});

	it("answers a never-configured project with a null config, not an error", async () => {
		rows.scoped = [[ROW], [], [], []];
		expect(await client(actor("org-1")).preview({ project: "shop" })).toMatchObject({
			config: null,
			fabrics: [],
			gitCredentials: [],
		});
	});

	it("answers null for a slug that names no project — the page's 404 — and reads nothing else", async () => {
		rows.scoped = [[], [CONFIG], [FABRIC], [CRED]];
		expect(await client(actor("org-1")).preview({ project: "gone" })).toBeNull();
		expect(rows.scoped).toHaveLength(3);
	});

	it("is FORBIDDEN, and reads nothing else, when the PDP refuses view on the project", async () => {
		rows.scoped = [[ROW], [CONFIG], [FABRIC], [CRED]];
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("view", { type: "project", id: ROW.id }));
		const error = await client(actor("org-1"))
			.preview({ project: "shop" })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "FORBIDDEN", defined: true });
		expect(rows.scoped).toHaveLength(3);
	});
});
