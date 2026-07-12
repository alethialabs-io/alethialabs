// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the env-status CAS wrapper (lib/db/env-status.ts). The RPC itself is exercised
// against real Postgres in tests/integration/env-status-cas.test.ts; here we mock db.execute and
// assert the wrapper's contract: on a rejected (lost-race) transition it logs + emits a
// status-conflict alert and returns false WITHOUT throwing, and the transition table stays complete.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/observability/log", () => ({
	log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { log } from "@/lib/observability/log";
import {
	ENV_TRANSITIONS,
	type EnvTransitionContext,
	setEnvStatus,
	transitionEnv,
} from "@/lib/db/env-status";

/** A fake db whose `execute` returns the CAS result `[{ updated }]`. */
function fakeDb(updated: boolean) {
	const execute = vi.fn().mockResolvedValue([{ updated }]);
	return { db: { execute } as never, execute };
}

beforeEach(() => vi.clearAllMocks());

describe("setEnvStatus", () => {
	it("returns true and stays quiet when the CAS moves a row", async () => {
		const { db, execute } = fakeDb(true);
		const ok = await setEnvStatus(db, "env-1", ["QUEUED"], "PROVISIONING", "job-1", {
			orgId: "org-1",
			projectId: "p1",
			context: "deployStart",
		});
		expect(ok).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(log.warn).not.toHaveBeenCalled();
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("returns false WITHOUT throwing on a rejected transition, and logs + alerts", async () => {
		const { db } = fakeDb(false);
		// The canonical clobber: a late DEPLOY-SUCCESS trying DESTROYED → ACTIVE.
		const ok = await setEnvStatus(db, "env-9", ["PROVISIONING", "QUEUED"], "ACTIVE", "job-9", {
			orgId: "org-1",
			projectId: "p1",
			context: "deploySuccess",
		});
		expect(ok).toBe(false); // no throw
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"system.project.status_conflict",
			expect.objectContaining({
				severity: "warning",
				resource_id: "env-9",
				project_id: "p1",
				job_id: "job-9",
			}),
		);
	});

	it("logs but does not alert when no org is known", async () => {
		const { db } = fakeDb(false);
		const ok = await setEnvStatus(db, "env-2", ["ACTIVE"], "QUEUED", null, {
			context: "enqueueDeploy",
		});
		expect(ok).toBe(false);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});
});

describe("transitionEnv", () => {
	it("applies the named transition's from-set + to from the table", async () => {
		const { db, execute } = fakeDb(true);
		const ok = await transitionEnv(db, "env-1", "destroySuccess", "job-1", {
			orgId: "org-1",
		});
		expect(ok).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		// The SQL binds the table's from-set + target — sanity-check the table itself.
		expect(ENV_TRANSITIONS.destroySuccess).toEqual({
			from: ["DESTROYING", "QUEUED"],
			to: "DESTROYED",
		});
	});
});

describe("ENV_TRANSITIONS table", () => {
	// Every flow context a real code path uses must be present, or a caller can't route its write.
	const REQUIRED_CONTEXTS: EnvTransitionContext[] = [
		"enqueuePlan",
		"enqueueDeploy",
		"enqueueDestroy",
		"enqueueAutoHeal",
		"deployStart",
		"deploySuccess",
		"deployFailed",
		"planSuccess",
		"planFailed",
		"destroyStart",
		"destroySuccess",
		"destroyFailed",
	];

	it("covers every context used by a real flow", () => {
		for (const ctx of REQUIRED_CONTEXTS) {
			expect(ENV_TRANSITIONS[ctx]).toBeDefined();
			expect(ENV_TRANSITIONS[ctx].from.length).toBeGreaterThan(0);
		}
	});

	it("never lets a deploy/plan success resurrect a DESTROYED env (the clobber fix)", () => {
		// DESTROYED must not appear in any from-set that moves toward a live state — otherwise a
		// late DEPLOY/PLAN callback could clobber a torn-down env.
		expect(ENV_TRANSITIONS.deploySuccess.from).not.toContain("DESTROYED");
		expect(ENV_TRANSITIONS.deployStart.from).not.toContain("DESTROYED");
		expect(ENV_TRANSITIONS.planSuccess.from).not.toContain("DESTROYED");
	});
});
