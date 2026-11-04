// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Break-glass `retry_job` copies ONLY a job whose kind the product re-run may copy
// (lib/jobs/operation.ts) — one whose copy acts on nothing but its own input. Every other job acts on
// a project's environment, a runner or a project's source, and is refused with where to act
// instead. Driven through the dispatcher (`executeBreakglassAction`), with the session gate, the
// audit rows and the database stubbed; "queues nothing" is counted as INSERT calls, so a guard that
// moved below the insert would fail here.

import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(
	(): {
		original: Record<string, unknown> | null;
		inserted: unknown[];
		updates: { set: unknown; where: unknown }[];
		flipped: unknown[];
	} => ({ original: null, inserted: [], updates: [], flipped: [] }),
);
const notifyRunnerCancel = vi.hoisted(() => vi.fn(async (_runner: string, _job: string) => undefined));
vi.mock("@/lib/runners/cancel-signal", () => ({ notifyRunnerCancel }));

vi.mock("@/lib/breakglass/session", () => ({ getLiveSession: async () => ({ id: "session-1" }) }));
vi.mock("@/lib/breakglass/audit", () => ({ writeAttemptAudit: vi.fn(), writeResultAudit: vi.fn() }));
vi.mock("@/lib/breakglass/approval", () => ({ consumeApproval: vi.fn() }));
vi.mock("@/lib/fleet/scaler", () => ({ wakeFleetScaler: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: (row: unknown) => row }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/billing/webhook-handler", () => ({ handleStripeEvent: vi.fn() }));
vi.mock("@/lib/billing/webhook-events", () => ({
	claimWebhookEvent: vi.fn(),
	markWebhookEventDone: vi.fn(),
	resetWebhookEvent: vi.fn(),
}));
vi.mock("@/lib/db", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: async () => (db.original ? [db.original] : []),
		update: () => ({
			set: (set: unknown) => ({
				where: (where: unknown) => ({
					returning: async () => {
						db.updates.push({ set, where });
						return db.flipped;
					},
				}),
			}),
		}),
		insert: () => ({
			values: (row: unknown) => {
				db.inserted.push(row);
				return { returning: async () => [{ id: "copy-1" }] };
			},
		}),
	});
	return { getServiceDb: () => chain };
});

import { executeBreakglassAction } from "@/lib/breakglass/actions";
import type { BreakglassOperator } from "@/lib/breakglass/auth";
import { provisionJobType } from "@/lib/db/schema/enums";

const JOB = "11111111-1111-4111-8111-111111111111";
const operator: BreakglassOperator = { email: "ops@example.test", userId: null };

/** Retries `JOB` with the given original row. */
function retry(original: Record<string, unknown>) {
	db.original = { user_id: "u-1", org_id: "o-1", config_snapshot: {}, cloud_identity_id: null, ...original };
	return executeBreakglassAction(operator, {
		sessionId: "session-1",
		action: "retry_job",
		resourceId: JOB,
		confirm: JOB,
		reason: "stuck after a runner restart",
	});
}

beforeEach(() => {
	db.original = null;
	db.inserted = [];
	db.updates = [];
	db.flipped = [];
	notifyRunnerCancel.mockClear();
});

describe("break-glass retry_job copies only an allow-listed kind", () => {
	it("copies an org-level AUDIT with NULL project and environment, as the operator, for the original's user and org", async () => {
		const result = await retry({ job_type: "AUDIT", project_id: null, environment_id: null });
		expect(result).toMatchObject({ ok: true, data: { jobId: "copy-1" } });
		expect(db.inserted).toHaveLength(1);
		const row = db.inserted[0];
		expect(row).toMatchObject({ job_type: "AUDIT", initiated_by: "operator", user_id: "u-1", org_id: "o-1", status: "QUEUED" });
		expect(row).not.toHaveProperty("project_id");
		expect(row).not.toHaveProperty("environment_id");
	});

	it.each(provisionJobType.enumValues.filter((t) => t !== "AUDIT"))(
		"refuses a %s and queues nothing — with or without a project",
		async (job_type) => {
			for (const shape of [
				{ project_id: null, environment_id: null },
				{ project_id: "p-1", environment_id: "e-1" },
			]) {
				const result = await retry({ job_type, ...shape });
				expect(result).toMatchObject({ ok: false, code: 409 });
			}
			expect(db.inserted).toHaveLength(0);
		},
	);

	it("refuses an AUDIT of a project and queues nothing", async () => {
		expect(await retry({ job_type: "AUDIT", project_id: "p-1", environment_id: null })).toMatchObject({ ok: false, code: 409 });
		expect(db.inserted).toHaveLength(0);
	});
});

describe("break-glass cancel_job keeps the product cancel's write discipline", () => {
	/** Cancels `JOB` as the operator. */
	function cancel(original: Record<string, unknown>, flipped: unknown[]) {
		db.original = original;
		db.flipped = flipped;
		return executeBreakglassAction(operator, {
			sessionId: "session-1",
			action: "cancel_job",
			resourceId: JOB,
			confirm: JOB,
			reason: "runner wedged on a lock",
		});
	}
	const dialect = new PgDialect();

	it("flips only from a cancellable status, and stamps completed_at", async () => {
		expect(await cancel({ status: "QUEUED" }, [{ runner_id: null }])).toMatchObject({ ok: true });
		const [update] = db.updates;
		expect(update?.set).toMatchObject({ status: "CANCELLED", completed_at: expect.any(Date) });
		expect(is(update?.where, SQL) ? dialect.sqlToQuery(update.where).sql : "").toContain('"jobs"."status" in');
		expect(notifyRunnerCancel).not.toHaveBeenCalled();
	});

	it("a job that finished between the read and the write is not rewritten, and nothing is signalled", async () => {
		expect(await cancel({ status: "PROCESSING" }, [])).toMatchObject({ ok: false, code: 400 });
		expect(notifyRunnerCancel).not.toHaveBeenCalled();
	});

	it("a job read as QUEUED but claimed before the flip is signalled — from what the flip changed", async () => {
		expect(await cancel({ status: "QUEUED" }, [{ runner_id: "runner-7" }])).toMatchObject({ ok: true });
		expect(notifyRunnerCancel).toHaveBeenCalledWith("runner-7", JOB);
	});
});
