// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// The scope ceiling (lib/authz/scope-ceiling.ts): which scope each action needs, which projects a
// reference touches, and the PDP wrapper `getPdp` returns. The database is mocked at
// `getServiceDb` (the job → project lookup) and the activity recorder at `enforceDecision`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { jobRows, jobWhere, enforceDecision } = vi.hoisted(() => ({
	jobRows: vi.fn(),
	jobWhere: vi.fn(),
	enforceDecision: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				where: (predicate: unknown) => {
					jobWhere(predicate);
					return Promise.resolve(jobRows());
				},
			}),
		}),
	}),
}));

vi.mock("@/lib/authz/activity", () => ({ enforceDecision }));

import { AGENT_SCOPES } from "@/lib/approvals/types";
import { type Action, PERMISSIONS } from "@/lib/authz/registry";
import {
	ceilingDecision,
	ceilingFrom,
	filterToCeiling,
	INSUFFICIENT_SCOPE,
	isUnrestricted,
	PROJECT_NOT_PERMITTED,
	requiredScopes,
	UNRESTRICTED_CEILING,
	withScopeCeiling,
} from "@/lib/authz/scope-ceiling";
import { type BulkCheck, type Decision, ForbiddenError, type Pdp, type ResolvedScope, type ResourceRef, type ScopeCeiling } from "@/lib/authz/types";

const ORG = "org-a";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const JOB_IN_A = "33333333-3333-4333-8333-333333333333";
const JOB_IN_B = "44444444-4444-4444-8444-444444444444";

/** An actor in ORG with the given ceiling (none when omitted). */
function actor(ceiling?: ScopeCeiling): ResolvedScope {
	return ceiling ? { userId: "u-1", orgId: ORG, ceiling } : { userId: "u-1", orgId: ORG };
}

const READ_ONLY: ScopeCeiling = { scopes: ["read"], projectIds: null };
const ALL_ON_A: ScopeCeiling = { scopes: AGENT_SCOPES, projectIds: [PROJECT_A] };

beforeEach(() => {
	vi.clearAllMocks();
	jobRows.mockReturnValue([]);
	enforceDecision.mockImplementation(
		(_actor: ResolvedScope, action: Action, resource: ResourceRef, decision: Decision) => {
			if (!decision.allowed) throw new ForbiddenError(action, resource, decision.reason);
		},
	);
});

describe("requiredScopes", () => {
	it("names the lifecycle scope for each project verb", () => {
		expect(requiredScopes("view", "project")).toEqual(["read"]);
		expect(requiredScopes("create", "project")).toEqual(["design"]);
		expect(requiredScopes("edit", "project")).toEqual(["design"]);
		expect(requiredScopes("plan", "project")).toEqual(["plan"]);
		expect(requiredScopes("audit", "project")).toEqual(["plan"]);
		expect(requiredScopes("deploy", "project")).toEqual(["apply"]);
		expect(requiredScopes("destroy", "project")).toEqual(["destroy"]);
	});

	it("requires every scope for administration of the org", () => {
		expect(requiredScopes("manage_tokens", "org")).toEqual(AGENT_SCOPES);
		expect(requiredScopes("manage_members", "member")).toEqual(AGENT_SCOPES);
		expect(requiredScopes("manage_identities", "cloud_identity")).toEqual(AGENT_SCOPES);
		expect(requiredScopes("destroy", "runner")).toEqual(AGENT_SCOPES);
		expect(requiredScopes("access_admin", "cluster")).toEqual(AGENT_SCOPES);
	});

	it("gives every registered permission a non-empty requirement of known scopes", () => {
		const bad = PERMISSIONS.filter((p) => {
			const needed = requiredScopes(p.action, p.resource);
			return needed.length === 0 || needed.some((s) => !AGENT_SCOPES.includes(s));
		}).map((p) => p.key);
		expect(bad).toEqual([]);
	});
});

describe("ceilingDecision — scopes", () => {
	it("allows everything for an actor with no ceiling, without a lookup", async () => {
		expect(await ceilingDecision(actor(), "manage_tokens", { type: "org" })).toEqual({ allowed: true });
		expect(jobWhere).not.toHaveBeenCalled();
	});

	it("refuses a read-only token a plan with insufficient_scope", async () => {
		const decision = await ceilingDecision(actor(READ_ONLY), "plan", { type: "project", id: PROJECT_A });
		expect(decision).toEqual({ allowed: false, reason: INSUFFICIENT_SCOPE });
	});

	it("refuses a read-only token every write it could be asked for", async () => {
		const allowed: string[] = [];
		for (const p of PERMISSIONS) {
			if (requiredScopes(p.action, p.resource).every((s) => s === "read")) continue;
			const d = await ceilingDecision(actor(READ_ONLY), p.action, { type: p.resource, id: "x" });
			if (d.allowed || d.reason !== INSUFFICIENT_SCOPE) allowed.push(p.key);
		}
		expect(allowed).toEqual([]);
	});

	it("lets a read-only token read", async () => {
		expect(await ceilingDecision(actor(READ_ONLY), "view", { type: "project", id: PROJECT_A })).toEqual({
			allowed: true,
		});
	});

	it("refuses an apply to a token without the apply scope, and a destroy without destroy", async () => {
		const planner: ScopeCeiling = { scopes: ["read", "design", "plan"], projectIds: null };
		expect(await ceilingDecision(actor(planner), "deploy", { type: "project", id: PROJECT_A })).toMatchObject({
			allowed: false,
			reason: INSUFFICIENT_SCOPE,
		});
		expect(await ceilingDecision(actor(planner), "destroy", { type: "project", id: PROJECT_A })).toMatchObject({
			allowed: false,
			reason: INSUFFICIENT_SCOPE,
		});
		expect(await ceilingDecision(actor(planner), "plan", { type: "project", id: PROJECT_A })).toEqual({
			allowed: true,
		});
	});

	// The backfilled default: every scope, every project. It must narrow nothing and read nothing.
	it("an unrestricted ceiling allows every registered permission without a lookup", async () => {
		const refused: string[] = [];
		for (const p of PERMISSIONS) {
			for (const id of [undefined, "some-id"]) {
				const d = await ceilingDecision(actor(UNRESTRICTED_CEILING), p.action, { type: p.resource, id });
				if (!d.allowed) refused.push(`${p.key}:${id ?? "-"}`);
			}
		}
		expect(refused).toEqual([]);
		expect(jobWhere).not.toHaveBeenCalled();
	});
});

describe("ceilingDecision — project list", () => {
	it("admits a project on the list and refuses one off it", async () => {
		expect(await ceilingDecision(actor(ALL_ON_A), "view", { type: "project", id: PROJECT_A })).toEqual({
			allowed: true,
		});
		expect(await ceilingDecision(actor(ALL_ON_A), "view", { type: "project", id: PROJECT_B })).toEqual({
			allowed: false,
			reason: PROJECT_NOT_PERMITTED,
		});
	});

	it("refuses a project reference with no id (a create, an unfiltered list)", async () => {
		expect(await ceilingDecision(actor(ALL_ON_A), "create", { type: "project" })).toMatchObject({
			allowed: false,
		});
		expect(await ceilingDecision(actor(ALL_ON_A), "view", { type: "project" })).toMatchObject({
			allowed: false,
		});
	});

	it("admits a job of a listed project, read in the actor's own org", async () => {
		jobRows.mockReturnValue([{ id: JOB_IN_A, project_id: PROJECT_A }]);
		expect(await ceilingDecision(actor(ALL_ON_A), "view", { type: "job", id: JOB_IN_A })).toEqual({
			allowed: true,
		});
		expect(jobWhere).toHaveBeenCalledTimes(1);
	});

	it("refuses a job of another project, a job not found in the org, and a job with no project", async () => {
		const cases: [string, unknown[]][] = [
			[JOB_IN_B, [{ id: JOB_IN_B, project_id: PROJECT_B }]],
			// Another org's job: the lookup is scoped to the actor's org, so it finds nothing.
			[JOB_IN_B, []],
			[JOB_IN_A, [{ id: JOB_IN_A, project_id: null }]],
			["not-a-uuid", []],
		];
		const allowed: string[] = [];
		for (const [id, found] of cases) {
			jobRows.mockReturnValue(found);
			const d = await ceilingDecision(actor(ALL_ON_A), "view", { type: "job", id });
			if (d.allowed) allowed.push(id);
		}
		expect(allowed).toEqual([]);
	});

	it("refuses a cluster, whose project is not resolved here", async () => {
		expect(
			await ceilingDecision(actor(ALL_ON_A), "access_readonly", { type: "cluster", id: "c-1" }),
		).toEqual({ allowed: false, reason: PROJECT_NOT_PERMITTED });
	});

	it("refuses org-level resources, read or write, since they can describe every project", async () => {
		const allowed: string[] = [];
		for (const p of PERMISSIONS) {
			if (p.resource === "project" || p.resource === "job") continue;
			const d = await ceilingDecision(actor(ALL_ON_A), p.action, { type: p.resource });
			if (d.allowed) allowed.push(p.key);
		}
		expect(allowed).toEqual([]);
	});
});

describe("filterToCeiling", () => {
	it("narrows projects to the list and jobs to the listed projects", async () => {
		expect(await filterToCeiling(actor(ALL_ON_A), "view", "project", [PROJECT_A, PROJECT_B])).toEqual([
			PROJECT_A,
		]);
		jobRows.mockReturnValue([
			{ id: JOB_IN_A, project_id: PROJECT_A },
			{ id: JOB_IN_B, project_id: PROJECT_B },
		]);
		expect(await filterToCeiling(actor(ALL_ON_A), "view", "job", [JOB_IN_A, JOB_IN_B])).toEqual([JOB_IN_A]);
	});

	it("returns nothing for a verb the scopes do not cover", async () => {
		expect(await filterToCeiling(actor(READ_ONLY), "deploy", "project", [PROJECT_A])).toEqual([]);
	});

	it("passes ids through for no ceiling and for the unrestricted one", async () => {
		const ids = [PROJECT_A, PROJECT_B];
		expect(await filterToCeiling(actor(), "view", "project", ids)).toEqual(ids);
		expect(await filterToCeiling(actor(UNRESTRICTED_CEILING), "view", "project", ids)).toEqual(ids);
	});
});

describe("withScopeCeiling — the PDP getPdp returns", () => {
	/** An engine that allows everything and lists both projects. */
	function allowAll(): Pdp {
		return {
			can: vi.fn(async () => ({ allowed: true })),
			enforce: vi.fn(async () => undefined),
			bulkCheck: vi.fn(async (_a: ResolvedScope, checks: BulkCheck[]) => checks.map(() => ({ allowed: true }))),
			listAccessible: vi.fn(async () => [PROJECT_A, PROJECT_B]),
		};
	}

	it("a ceiling refusal wins over the engine's allow in can, and the engine is not asked", async () => {
		const inner = allowAll();
		const pdp = withScopeCeiling(inner);
		expect(await pdp.can(actor(READ_ONLY), "plan", { type: "project", id: PROJECT_A })).toEqual({
			allowed: false,
			reason: INSUFFICIENT_SCOPE,
		});
		expect(inner.can).not.toHaveBeenCalled();
	});

	it("enforce records and throws a ceiling refusal like a PDP denial", async () => {
		const inner = allowAll();
		const pdp = withScopeCeiling(inner);
		await expect(
			pdp.enforce(actor(ALL_ON_A), "view", { type: "project", id: PROJECT_B }),
		).rejects.toBeInstanceOf(ForbiddenError);
		expect(enforceDecision).toHaveBeenCalledWith(
			actor(ALL_ON_A),
			"view",
			{ type: "project", id: PROJECT_B },
			{ allowed: false, reason: PROJECT_NOT_PERMITTED },
		);
		expect(inner.enforce).not.toHaveBeenCalled();
	});

	it("enforce stays closed even if the recorder stops throwing", async () => {
		enforceDecision.mockImplementation(() => undefined);
		const pdp = withScopeCeiling(allowAll());
		await expect(
			pdp.enforce(actor(READ_ONLY), "deploy", { type: "project", id: PROJECT_A }),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("bulkCheck merges ceiling refusals over the engine's answers", async () => {
		const pdp = withScopeCeiling(allowAll());
		const out = await pdp.bulkCheck(actor(READ_ONLY), [
			{ action: "view", resource: { type: "project", id: PROJECT_A } },
			{ action: "plan", resource: { type: "project", id: PROJECT_A } },
		]);
		expect(out).toEqual([{ allowed: true }, { allowed: false, reason: INSUFFICIENT_SCOPE }]);
	});

	it("listAccessible filters the engine's ids to the project list", async () => {
		const pdp = withScopeCeiling(allowAll());
		expect(await pdp.listAccessible(actor(ALL_ON_A), "view", "project")).toEqual([PROJECT_A]);
	});

	it("passes an actor with no ceiling straight to the engine", async () => {
		const inner = allowAll();
		const pdp = withScopeCeiling(inner);
		await pdp.enforce(actor(), "manage_tokens", { type: "org" });
		expect(inner.enforce).toHaveBeenCalledTimes(1);
		expect(await pdp.listAccessible(actor(), "view", "project")).toEqual([PROJECT_A, PROJECT_B]);
	});

	it("the engine's denial still stands under an unrestricted ceiling", async () => {
		const inner = allowAll();
		vi.mocked(inner.can).mockResolvedValue({ allowed: false, reason: "no_grant" });
		const pdp = withScopeCeiling(inner);
		expect(await pdp.can(actor(UNRESTRICTED_CEILING), "view", { type: "project", id: PROJECT_A })).toEqual({
			allowed: false,
			reason: "no_grant",
		});
	});
});

describe("ceilingFrom — reading a limit from untrusted input", () => {
	it("reads a valid limit", () => {
		expect(ceilingFrom(["read", "plan"], null)).toEqual({ scopes: ["read", "plan"], projectIds: null });
		expect(ceilingFrom(["read"], [PROJECT_A])).toEqual({ scopes: ["read"], projectIds: [PROJECT_A] });
	});

	it("refuses no scope, an unknown scope, and an absent or empty project list", () => {
		const inputs: [unknown, unknown][] = [
			[undefined, null],
			[[], null],
			[["read", "admin"], null],
			["read", null],
			[["read"], undefined],
			[["read"], []],
			[["read"], [""]],
		];
		const accepted = inputs.filter(([s, p]) => ceilingFrom(s, p) !== null);
		expect(accepted).toEqual([]);
	});

	it("isUnrestricted is true only for every scope over every project", () => {
		expect(isUnrestricted(UNRESTRICTED_CEILING)).toBe(true);
		expect(isUnrestricted({ scopes: AGENT_SCOPES, projectIds: [PROJECT_A] })).toBe(false);
		expect(isUnrestricted(READ_ONLY)).toBe(false);
	});
});
