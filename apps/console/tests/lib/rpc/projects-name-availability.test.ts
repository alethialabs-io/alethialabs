// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// F035 (#6131): the Configure screen's inline name check, `projects.nameAvailability`. Its answer is
// only worth showing if it is the answer the CREATE will give, so each assertion here is one of the
// two rules `insertProjectWithDefaultFabric` (lib/queries/projects.ts) applies at create time:
//   · the NAME collides case-insensitively — `projects_org_id_project_name_key` is UNIQUE on
//     (org_id, lower(project_name)), so "API" is taken when "api" exists;
//   · the SLUG is de-duplicated over the org's slugs AND the reserved project-child segments, so the
//     preview says `api-2` where the screen used to promise `api` (the finding: "tovr/a640" shown as
//     if it were free).
// Mocked boundary: the guard and the RLS transaction (a chain answering the org's project rows).
// The integration tenancy proof (tests/integration/rpc-tenancy.shared.ts) covers whose rows those are.

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const org = vi.hoisted(() => {
	const state: { rows: { slug: string | null; project_name: string }[]; orgFilter: unknown } = {
		rows: [],
		orgFilter: undefined,
	};
	return state;
});

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
	currentActor: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/db", () => ({
	withActorScope: async (_actor: unknown, fn: (tx: unknown) => unknown) => {
		const tx: Record<string, unknown> = {};
		Object.assign(tx, {
			select: () => tx,
			from: () => tx,
			where: (w: unknown) => {
				org.orgFilter = w;
				return Promise.resolve(org.rows);
			},
		});
		return fn(tx);
	},
}));
// The module's other readers (the import flow's git accounts, the model inference, the duplicate
// dialog's design read) are not this file's subject.
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/jobs/visibility", () => ({ jobVisibleTo: vi.fn() }));
vi.mock("@/app/server/actions/aws/identities", () => ({ getVerifiedCloudIdentities: vi.fn() }));
vi.mock("@/app/server/actions/projects", () => ({ getProjectAsFormData: vi.fn() }));
vi.mock("@/lib/scanner/infer", () => ({ inferStack: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ recordAiUsage: vi.fn(), meteringFailed: vi.fn() }));

const { authorize } = await import("@/lib/authz/guard");
const { readNameAvailability } = await import("@/lib/rpc/procedures/projects");

beforeEach(() => {
	org.rows = [];
	org.orgFilter = undefined;
	vi.mocked(authorize).mockClear();
});

describe("readNameAvailability — the create's own two rules, asked early (F035)", () => {
	it("a free name is available, and its slug is the plain one", async () => {
		org.rows = [{ slug: "web", project_name: "Web" }];
		expect(await readNameAvailability("api")).toEqual({ available: true, slug: "api" });
		expect(authorize).toHaveBeenCalledWith("view", { type: "project" });
		// Asked of the actor's own org, explicitly — not left to RLS alone (the create's predicate).
		expect(org.orgFilter).toBeInstanceOf(SQL);
		if (!(org.orgFilter instanceof SQL)) return;
		const where = new PgDialect().sqlToQuery(org.orgFilter);
		expect(where.sql).toBe('"projects"."org_id" = $1');
		expect(where.params).toEqual(["org-1"]);
	});

	it("a name the org holds is taken, compared without regard to case", async () => {
		org.rows = [{ slug: "api", project_name: "api" }];
		expect((await readNameAvailability("API")).available).toBe(false);
		expect((await readNameAvailability("  api  ")).available).toBe(false);
	});

	it("previews the slug the create will REALLY give: de-duplicated against the org's slugs", async () => {
		// A different NAME on the same slug: the name is free, the slug is not.
		org.rows = [{ slug: "api", project_name: "Backend" }];
		expect(await readNameAvailability("API")).toEqual({ available: true, slug: "api-2" });
	});

	it("never previews a slug a project-scoped route shadows", async () => {
		expect((await readNameAvailability("Settings")).slug).toBe("settings-2");
	});
});
