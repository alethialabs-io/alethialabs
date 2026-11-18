// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary test: `deleteOrganization` answers `conflict` while any environment of any project
// in the organization is live or in flight, and deletes otherwise (#6752). The actor, the PDP and
// better-auth's dispatcher are stubs; the database is a table-aware thenable chain, so the read in
// `liveEnvironmentsInOrg` (lib/db/live-env-statuses.ts) runs for real over seeded rows.
//
// What each case holds: the refusal comes BEFORE better-auth is asked to delete anything, records
// nothing as done, and names what blocks it; a status that does not block lets the delete through.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers({ cookie: "better-auth.session_token=s1" })),
}));
vi.mock("@/lib/auth", () => ({ auth: { handler: vi.fn() } }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn(), authorizeInOrg: vi.fn() }));
const { pdpCan } = vi.hoisted(() => ({ pdpCan: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: pdpCan }) }));
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: vi.fn() }));
// `enforceDecision` keeps its real contract (a refusal throws); the recorder is a spy.
vi.mock("@/lib/authz/activity", async () => {
	const { ForbiddenError } = await import("@/lib/authz/types");
	return {
		recordActivity: vi.fn(),
		enforceDecision: vi.fn(
			(_actor: unknown, action: "edit", resource: { type: "org" }, decision: { allowed: boolean }) => {
				if (!decision.allowed) throw new ForbiddenError(action, resource);
			},
		),
	};
});
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { deleteOrganization } from "@/app/server/actions/org-settings";
import { emitActionEvent } from "@/lib/alerts/emit";
import { auth } from "@/lib/auth";
import { recordActivity } from "@/lib/authz/activity";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import { type ProjectStatus, projectStatus } from "@/lib/db/schema/enums";

/** One seeded environment row, as `liveEnvironmentsInOrg` selects it. */
interface EnvRow {
	projectId: string;
	name: string;
	status: ProjectStatus;
}

/** A drizzle-ish chain that awaits to the rows seeded for the table named in `.from()`. */
function seedDb(projectRows: { id: string; name: string }[], envRows: EnvRow[]) {
	const fromSpy = vi.fn<(table: unknown) => void>();
	const db = {
		select: () => {
			let table: unknown;
			const chain: Record<string, unknown> = {};
			Object.assign(chain, {
				from: (t: unknown) => {
					table = t;
					fromSpy(t);
					return chain;
				},
				where: () => chain,
				limit: () => chain,
				then: (resolve: (rows: unknown[]) => void) =>
					resolve(table === projects ? projectRows : table === projectEnvironments ? envRows : []),
			});
			return chain;
		},
	};
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { fromSpy };
}

/** Which statuses block, written out — not read from the set the action uses. */
const BLOCKS: Record<ProjectStatus, boolean> = {
	DRAFT: false,
	QUEUED: true,
	PROVISIONING: true,
	ACTIVE: true,
	FAILED: false,
	DESTROYING: true,
	DESTROYED: false,
};
const blocking = projectStatus.enumValues.filter((s) => BLOCKS[s]);
const nonBlocking = projectStatus.enumValues.filter((s) => !BLOCKS[s]);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1", credential: "session" } as never);
	pdpCan.mockResolvedValue({ allowed: true });
	vi.mocked(auth.handler).mockResolvedValue(Response.json({ id: "org-1" }, { status: 200 }));
});

describe("deleteOrganization while an environment is live or in flight", () => {
	it("covers every status on one side or the other", () => {
		expect([...blocking, ...nonBlocking].sort()).toEqual([...projectStatus.enumValues].sort());
		expect(blocking).toHaveLength(4);
	});

	it.each(blocking)("%s → conflict, naming the environment, and nothing is deleted", async (status) => {
		seedDb([{ id: "p1", name: "Shop" }], [{ projectId: "p1", name: "prod", status }]);
		expect(await deleteOrganization({})).toEqual({
			ok: false,
			error: {
				kind: "conflict",
				message:
					"This organization has a live or in-flight environment: Shop / prod. Destroy it before deleting the organization.",
			},
		});
		expect(auth.handler).not.toHaveBeenCalled();
		expect(recordActivity).not.toHaveBeenCalled();
		expect(emitActionEvent).not.toHaveBeenCalled();
	});

	it.each(nonBlocking)("%s → the organization is deleted", async (status) => {
		seedDb([{ id: "p1", name: "Shop" }], [{ projectId: "p1", name: "prod", status }]);
		expect(await deleteOrganization({})).toEqual({ ok: true, data: { deleted: true } });
		expect(auth.handler).toHaveBeenCalledTimes(1);
	});

	it("an organization with no projects is deleted, without reading environments", async () => {
		const { fromSpy } = seedDb([], [{ projectId: "elsewhere", name: "prod", status: "ACTIVE" }]);
		expect(await deleteOrganization({})).toEqual({ ok: true, data: { deleted: true } });
		expect(fromSpy).toHaveBeenCalledTimes(1);
		expect(fromSpy).toHaveBeenCalledWith(projects);
	});

	it("names only the blocking environments, by project then environment", async () => {
		seedDb(
			[
				{ id: "p1", name: "Shop" },
				{ id: "p2", name: "Billing" },
			],
			[
				{ projectId: "p1", name: "staging", status: "PROVISIONING" },
				{ projectId: "p1", name: "dev", status: "DRAFT" },
				{ projectId: "p2", name: "prod", status: "ACTIVE" },
				{ projectId: "p1", name: "prod", status: "DESTROYING" },
				{ projectId: "p2", name: "old", status: "DESTROYED" },
			],
		);
		expect(await deleteOrganization({})).toEqual({
			ok: false,
			error: {
				kind: "conflict",
				message:
					"This organization has live or in-flight environments: Billing / prod, Shop / prod, Shop / staging. Destroy them before deleting the organization.",
			},
		});
	});

	it("names five and counts the rest", async () => {
		const envRows: EnvRow[] = Array.from({ length: 7 }, (_unused, i) => ({
			projectId: "p1",
			name: `env-${i + 1}`,
			status: "ACTIVE",
		}));
		seedDb([{ id: "p1", name: "Shop" }], envRows);
		const result = await deleteOrganization({});
		expect(result).toMatchObject({ ok: false, error: { kind: "conflict" } });
		expect(JSON.stringify(result)).toContain("Shop / env-5 and 2 more.");
		expect(JSON.stringify(result)).not.toContain("env-6");
	});

	it("does not read what is in the organization for someone the PDP refuses", async () => {
		const { fromSpy } = seedDb([{ id: "p1", name: "Shop" }], [{ projectId: "p1", name: "prod", status: "ACTIVE" }]);
		pdpCan.mockResolvedValue({ allowed: false });
		const result = await deleteOrganization({});
		expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
		expect(JSON.stringify(result)).not.toContain("Shop");
		expect(fromSpy).not.toHaveBeenCalled();
		expect(auth.handler).not.toHaveBeenCalled();
	});
});
