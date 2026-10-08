// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #5667: polling a kubeconfig mint is WAITING, not ACCESS, so it must not write to the org's activity
// log; handing over an ADMIN credential is access, and must be recorded exactly once.
//
// Before the fix every poll of an admin mint ran the recording `getPdp().enforce(…, "access_admin")`
// whatever the mint's status, and `enforceDecision` writes an `authz_activity_log` row for every allow
// of a non-read action — so both clients, which poll every two seconds, wrote one "accessed admin" row
// per poll while the mint was pending.
//
// This file keeps the REAL recording path end to end, through BOTH callers (the CLI route and the
// console server action): the real lib/kubeconfig-mint/poll.ts and gates.ts, the real
// `PostgresRbacPDP.enforce`, and the real `enforceDecision` / `recordActivity`. Only the grant lookup
// (`can`) is stubbed — so the test can revoke `access_admin` between polls — plus the DB handles (the
// RLS transaction holding one mint row, and the service handle so the activity INSERT is observable),
// the action-event emitter, and the callers' session/token resolution (each caller's own
// `access_readonly` gate is not what this file is about; the CLI route's is
// tests/kubeconfig-mint/cli-poll-entry-recording.test.ts, #5670).
//
// The security half: the hand-over must still REFUSE somebody who lost `access_admin` after the mint
// started, on a decision made at the hand-over — not one remembered from an earlier poll.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Status = "pending" | "ready" | "failed" | "expired";
interface FakeRow {
	status: Status;
	tier: "readonly" | "admin";
	sealed_result: string | null;
	expired_now: boolean;
	job_status: string | null;
}

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const MINT = "77777777-7777-4777-8777-777777777777";
const JOB = "88888888-8888-4888-8888-888888888888";
const SEALED = `${"A".repeat(40)}sealedCiphertextOnly${"b".repeat(30)}`;
const EXPIRES = new Date("2026-10-01T12:10:00.000Z");

/** The one mint row the fake RLS transaction holds; null once consumed. */
let row: FakeRow | null = null;
/** Every row handed to `insert(authz_activity_log).values(...)` on the service handle. */
let activityRows: Record<string, unknown>[] = [];
/** Whether the consuming DELETE ran. */
let deleted = false;

/** The RLS-scoped transaction: one head SELECT, the read-once DELETE, and the delivery audit insert. */
const fakeTx = {
	select: () => {
		const chain = {
			from: () => chain,
			innerJoin: () => chain,
			leftJoin: () => chain,
			where: () => chain,
			limit: async () =>
				row
					? [
							{
								status: row.status,
								tier: row.tier,
								shape: "exec",
								ttl_seconds: 3600,
								job_id: JOB,
								failure_reason: row.status === "failed" ? "boom" : null,
								private_endpoint: false,
								expires_at: EXPIRES,
								expired_now: row.expired_now,
								project_id: PROJECT,
								job_status: row.job_status,
							},
						]
					: [],
		};
		return chain;
	},
	delete: () => ({
		where: () => ({
			returning: async () => {
				deleted = true;
				if (!row || row.status !== "ready" || row.expired_now) return [];
				const taken = { sealed_result: row.sealed_result, private_endpoint: false };
				row = null;
				return [taken];
			},
		}),
	}),
	insert: () => ({ values: async () => undefined }),
};

vi.mock("@/lib/db", async () => {
	const { authzActivityLog } = await import("@/lib/db/schema");
	return {
		withActorScope: async (_actor: unknown, fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
		getServiceDb: () => ({
			insert: (table: unknown) => ({
				values: (v: Record<string, unknown>) => {
					if (table === authzActivityLog) activityRows.push(v);
					return { catch: () => undefined };
				},
			}),
		}),
	};
});
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeQuiet: vi.fn(),
	authorizeCli: vi.fn(),
	authorizeCliQuiet: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/kubeconfig-mint/request", () => ({ requestKubeconfigMint: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedClientIp: vi.fn(() => "198.51.100.4") }));
vi.mock("@/lib/observability/log", () => {
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
	return { log: logger };
});

import { GET } from "@/app/api/cli/clusters/[id]/kubeconfig/[mintId]/route";
import { pollKubeconfigDownload } from "@/app/server/actions/kubeconfig-download";
import { emitActionEvent } from "@/lib/alerts/emit";
import { getPdp } from "@/lib/authz";
import { authorizeCliQuiet, authorizeQuiet } from "@/lib/authz/guard";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import type { Actor } from "@/lib/authz/types";

const ACTOR: Actor = { userId: USER, orgId: ORG };

/** Whether the actor currently holds cluster:access_admin — flipped mid-mint to model a revocation. */
let holdsAdmin = true;
/** The real PDP, with only its grant lookup stubbed. */
let pdp: PostgresRbacPDP;

/** A normalised poll answer: the HTTP-ish status and the serialised body. */
interface Answer {
	status: number;
	body: string;
}

/** The two callers of lib/kubeconfig-mint/poll.ts, each driven exactly as a client drives it. */
const CALLERS: ReadonlyArray<[string, () => Promise<Answer>]> = [
	[
		"the CLI route",
		async () => {
			const res = await GET(
				new Request(`https://console.local/api/cli/clusters/${CLUSTER}/kubeconfig/${MINT}`),
				{ params: Promise.resolve({ id: CLUSTER, mintId: MINT }) },
			);
			return { status: res.status, body: await res.text() };
		},
	],
	[
		"the console action",
		async () => {
			const out = await pollKubeconfigDownload({ clusterId: CLUSTER, mintId: MINT });
			return out.ok
				? { status: 200, body: JSON.stringify(out.poll) }
				: { status: out.status, body: "" };
		},
	],
];

/** A mint row in `status` of `tier`. */
function mint(status: Status, tier: FakeRow["tier"] = "admin", over: Partial<FakeRow> = {}): FakeRow {
	return {
		status,
		tier,
		sealed_result: status === "ready" ? SEALED : null,
		expired_now: false,
		job_status: status === "pending" ? "PROCESSING" : "SUCCESS",
		...over,
	};
}

/** The access_admin activity rows and action events written so far. */
function adminTrail() {
	return {
		rows: activityRows.filter((r) => r.action === "access_admin"),
		events: vi.mocked(emitActionEvent).mock.calls.filter(([, action]) => action === "access_admin"),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	row = null;
	activityRows = [];
	deleted = false;
	holdsAdmin = true;
	pdp = new PostgresRbacPDP();
	vi.spyOn(pdp, "can").mockImplementation(async (_actor, action) =>
		action === "access_admin" && !holdsAdmin
			? { allowed: false, reason: "no_grant" }
			: { allowed: true },
	);
	vi.mocked(getPdp).mockReturnValue(pdp);
	vi.mocked(authorizeQuiet).mockResolvedValue(ACTOR);
	vi.mocked(authorizeCliQuiet).mockResolvedValue({
		actor: ACTOR,
		credential: "session",
		orgScope: [ORG, USER],
	});
});

describe.each(CALLERS)("%s — polling an admin mint records nothing until the hand-over (#5667)", (_name, poll) => {
	it("N polls of a PENDING admin mint write no access_admin row and emit no event", async () => {
		row = mint("pending");
		for (let i = 0; i < 5; i++) {
			const a = await poll();
			expect(a.status).toBe(200);
			expect(JSON.parse(a.body).status).toBe("pending");
		}
		expect(adminTrail()).toEqual({ rows: [], events: [] });
	});

	it("the hand-over of a READY admin mint records exactly one allow row, however long it was waited for", async () => {
		row = mint("pending");
		for (let i = 0; i < 3; i++) await poll();
		row = mint("ready");
		const handed = await poll();
		expect(handed.status).toBe(200);
		expect(JSON.parse(handed.body)).toEqual({ status: "ready", private_endpoint: false, sealed: SEALED });
		// The next poll finds nothing (read once) and records nothing more.
		expect((await poll()).status).toBe(404);
		const { rows, events } = adminTrail();
		expect(rows).toEqual([
			expect.objectContaining({
				org_id: ORG,
				actor_id: USER,
				resource_type: "cluster",
				resource_id: CLUSTER,
				decision: true,
			}),
		]);
		expect(events).toHaveLength(1);
		expect(events[0][3]).toBe(true);
	});

	it("SECURITY: access_admin revoked between polls — the hand-over refuses, records the denial once, consumes nothing", async () => {
		row = mint("pending");
		// The probes while pending were ALLOWED…
		for (let i = 0; i < 3; i++) expect((await poll()).status).toBe(200);
		// …then the person is demoted, and the runner finishes the mint.
		holdsAdmin = false;
		row = mint("ready");
		const refused = await poll();
		expect(refused.status).toBe(403);
		expect(refused.body).not.toContain(SEALED);
		// Decided afresh at the hand-over, not carried over from the allowed probes.
		expect(deleted).toBe(false);
		expect(row).not.toBeNull();
		const { rows, events } = adminTrail();
		expect(rows).toEqual([expect.objectContaining({ decision: false, reason: "no_grant" })]);
		expect(events).toHaveLength(1);
		expect(events[0][3]).toBe(false);
		// Polling on stays refused, and the credential stays unconsumed.
		expect((await poll()).status).toBe(403);
		expect(row?.sealed_result).toBe(SEALED);
	});

	it("revoked while still PENDING: the probe refuses at once and records nothing", async () => {
		row = mint("pending");
		holdsAdmin = false;
		expect((await poll()).status).toBe(403);
		expect(adminTrail()).toEqual({ rows: [], events: [] });
	});

	it.each([
		["pending", mint("pending")],
		["failed", mint("failed")],
		["expired", mint("expired")],
		["ready but past its window", mint("ready", "admin", { expired_now: true })],
		["pending with a dead job", mint("pending", "admin", { job_status: "FAILED" })],
	])("a %s admin mint never returns credential material and records nothing, allowed or not", async (_s, r) => {
		for (const granted of [true, false]) {
			holdsAdmin = granted;
			row = { ...r };
			const a = await poll();
			expect(a.body).not.toContain(SEALED);
			expect(a.body).not.toContain("sealed");
			expect(deleted).toBe(false);
		}
		expect(adminTrail()).toEqual({ rows: [], events: [] });
	});

	it("a READ-ONLY mint is gated exactly as before: no access_admin question at any status", async () => {
		row = mint("pending", "readonly");
		await poll();
		row = mint("ready", "readonly");
		const handed = await poll();
		expect(JSON.parse(handed.body).sealed).toBe(SEALED);
		expect(vi.mocked(pdp.can).mock.calls.map((c) => c[1])).not.toContain("access_admin");
		expect(adminTrail()).toEqual({ rows: [], events: [] });
	});
});
