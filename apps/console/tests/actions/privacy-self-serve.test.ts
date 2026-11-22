// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The account dialog's privacy actions (app/server/actions/privacy/self-serve.ts): "Delete account"
// and "Download my data".
//
// What is pinned, because each is a property the module's header claims:
//   · the subject is the SESSION's user — no action takes a subject argument;
//   · an injected (token) actor is refused before the session is even read, and nothing runs;
//   · no session → refused, and nothing runs;
//   · no caller-supplied clock: the lib receives a `Date` the action made itself;
//   · the export is rate-limited per account, and a refused hit builds nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, injected, schedule, blockers, createExport, rateLimit } = vi.hoisted(() => ({
	getSession: vi.fn(),
	injected: vi.fn(),
	schedule: vi.fn(),
	blockers: vi.fn(),
	createExport: vi.fn(),
	rateLimit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: () => injected() }));
vi.mock("@/lib/privacy/self-deletion", () => ({
	scheduleSelfErasure: (...a: unknown[]) => schedule(...a),
	deletionBlockers: (...a: unknown[]) => blockers(...a),
}));
vi.mock("@/lib/privacy/export", () => ({ createDataExport: (...a: unknown[]) => createExport(...a) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => rateLimit(...a) }));

import {
	myDeletionBlockers,
	requestMyDataExport,
	scheduleMyAccountDeletion,
} from "@/app/server/actions/privacy/self-serve";

const SESSION = { user: { id: "user-1", email: "ada@example.io" } };

beforeEach(() => {
	for (const m of [getSession, injected, schedule, blockers, createExport, rateLimit]) m.mockReset();
	injected.mockReturnValue(undefined);
	getSession.mockResolvedValue(SESSION);
	rateLimit.mockResolvedValue({ ok: true, remaining: 2 });
});

describe("scheduleMyAccountDeletion", () => {
	it("schedules the deletion of the SESSION's account, with a clock it made itself", async () => {
		schedule.mockResolvedValue({ outcome: "scheduled", reference: "DSR-00000001", scheduledFor: new Date() });
		await scheduleMyAccountDeletion();
		expect(schedule).toHaveBeenCalledWith({ userId: "user-1", email: "ada@example.io" }, expect.any(Date));
	});

	it("refuses a machine credential before it reads the session", async () => {
		injected.mockReturnValue({ userId: "user-1", orgId: "org-1" });
		await expect(scheduleMyAccountDeletion()).rejects.toThrow(/signed-in console session/);
		expect(getSession).not.toHaveBeenCalled();
		expect(schedule).not.toHaveBeenCalled();
	});

	it("refuses without a session and schedules nothing", async () => {
		getSession.mockResolvedValue(null);
		await expect(scheduleMyAccountDeletion()).rejects.toThrow("Unauthorized");
		expect(schedule).not.toHaveBeenCalled();
	});
});

describe("myDeletionBlockers", () => {
	it("asks about the session's account", async () => {
		blockers.mockResolvedValue([]);
		expect(await myDeletionBlockers()).toEqual([]);
		expect(blockers).toHaveBeenCalledWith("user-1");
	});
});

describe("requestMyDataExport", () => {
	it("builds the export for the session's account and reports the link's expiry", async () => {
		const expiresAt = new Date("2026-11-24T10:00:00.000Z");
		createExport.mockResolvedValue({ reference: "DSR-00000002", expiresAt });
		expect(await requestMyDataExport()).toEqual({ outcome: "emailed", reference: "DSR-00000002", expiresAt });
		expect(createExport).toHaveBeenCalledWith({ userId: "user-1", email: "ada@example.io" }, expect.any(Date));
		expect(rateLimit).toHaveBeenCalledWith("privacy-export:user-1", 3, 86_400_000);
	});

	it("builds nothing once the account has used its exports for the day", async () => {
		rateLimit.mockResolvedValue({ ok: false, remaining: 0 });
		expect(await requestMyDataExport()).toEqual({ outcome: "rate_limited" });
		expect(createExport).not.toHaveBeenCalled();
	});
});
