// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the support-case actions. Stubs the authz guard, the auth session,
// the request headers, the auth config, and a thenable drizzle chain run via withOwnerScope
// (each await pulls the next seeded result set). Exercises the internal status machine
// (TRANSITIONS / assertTransition / nextStatusAfterCustomerReply) THROUGH the exported actions:
// customer replies reopen settled cases, illegal transitions throw, submitCase inserts the case +
// first message, and a THROWING notification never fails the customer's submit (the safeNotify
// guarantee).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeQuiet: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/lib/config/auth", () => ({
	getAuthConfig: () => ({ baseURL: "http://localhost:3000" }),
}));
vi.mock("@/lib/email/support-email", () => ({
	sendCaseCreatedAck: vi.fn(),
	sendCaseRepliedEmail: vi.fn(),
	notifySupportInboxEmail: vi.fn(),
}));
vi.mock("@/lib/support/slack-notify", () => ({
	slackCaseCreated: vi.fn(),
	slackCaseReplied: vi.fn(),
}));

import {
	closeCase,
	postCaseMessage,
	reopenCase,
	resolveCase,
	submitCase,
} from "@/app/server/actions/support";
import { auth } from "@/lib/auth";
import { authorizeQuiet } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import {
	notifySupportInboxEmail,
	sendCaseCreatedAck,
	sendCaseRepliedEmail,
} from "@/lib/email/support-email";
import { slackCaseCreated, slackCaseReplied } from "@/lib/support/slack-notify";

/**
 * A drizzle-ish chain whose every builder returns itself; each `await` (then) shifts the next
 * seeded result set. Records `.values()`/`.set()`/`.where()` writes for assertions and drives the
 * withOwnerScope callback.
 */
function mockDb(resultSets: unknown[][]) {
	const setSpy = vi.fn();
	const valuesSpy = vi.fn();
	const whereSpy = vi.fn();
	let i = 0;
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		innerJoin: () => db,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return db;
		},
		limit: () => db,
		orderBy: () => db,
		insert: () => db,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		returning: () => db,
		onConflictDoUpdate: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => {
			const r = i < resultSets.length ? resultSets[i] : (resultSets.at(-1) ?? []);
			i++;
			return resolve(r);
		},
	});
	vi.mocked(withOwnerScope).mockImplementation(
		((_owner: unknown, cb: (tx: unknown) => unknown) => cb(db)) as never,
	);
	return { setSpy, valuesSpy, whereSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeQuiet).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { name: "Ada Lovelace", email: "ada@acme.io" },
	} as never);
	// notifications resolve as no-ops by default
	vi.mocked(sendCaseCreatedAck).mockResolvedValue(undefined);
	vi.mocked(sendCaseRepliedEmail).mockResolvedValue(undefined);
	vi.mocked(notifySupportInboxEmail).mockResolvedValue(undefined);
	vi.mocked(slackCaseCreated).mockResolvedValue(undefined);
	vi.mocked(slackCaseReplied).mockResolvedValue(undefined);
});

/** A valid new-case submit payload. */
const submitInput = {
	type: "technical",
	category: "clusters",
	severity: "high",
	subject: "Cluster is unreachable",
	description: "My production cluster stopped responding after the last apply.",
	context: { projectId: "proj-1" },
	contact: { notifyEmail: "ada@acme.io", channel: "email" },
} as const;

describe("submitCase", () => {
	it("inserts the case + first message and returns { id, caseNumber }", async () => {
		const { valuesSpy } = mockDb([
			[{ id: "case-1", case_number: 42 }], // insert case … returning
			[], // insert first message
		]);

		const result = await submitCase(submitInput);

		expect(authorizeQuiet).toHaveBeenCalledWith("create", { type: "support_case" });
		expect(result).toEqual({ id: "case-1", caseNumber: 42 });

		// case row insert
		expect(valuesSpy).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				user_id: "user-1",
				type: "technical",
				category: "clusters",
				severity: "high",
				status: "open",
				subject: "Cluster is unreachable",
				last_author_type: "customer",
			}),
		);
		// first thread message insert
		expect(valuesSpy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				case_id: "case-1",
				author_type: "customer",
				author_id: "user-1",
				author_name: "Ada Lovelace",
				body: submitInput.description,
			}),
		);
	});

	it("fires the ack email + Slack + inbox notifications best-effort", async () => {
		mockDb([[{ id: "case-1", case_number: 42 }], []]);
		await submitCase(submitInput);
		expect(sendCaseCreatedAck).toHaveBeenCalledWith(
			"ada@acme.io",
			expect.objectContaining({ caseNumber: 42, subject: "Cluster is unreachable" }),
		);
		expect(slackCaseCreated).toHaveBeenCalledWith(
			expect.objectContaining({ caseNumber: 42, severity: "high", orgId: "org-1" }),
		);
		expect(notifySupportInboxEmail).toHaveBeenCalledWith(
			expect.objectContaining({ caseNumber: 42, severity: "high" }),
		);
	});

	it("defaults contact to the session email when the submit omits it (Ask-AI path)", async () => {
		const { valuesSpy } = mockDb([[{ id: "case-1", case_number: 7 }], []]);
		const { contact: _drop, ...noContact } = submitInput;
		await submitCase(noContact);
		expect(valuesSpy).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				contact: { notifyEmail: "ada@acme.io", channel: "email" },
			}),
		);
		// the ack email still goes to the defaulted address
		expect(sendCaseCreatedAck).toHaveBeenCalledWith("ada@acme.io", expect.anything());
	});

	it("does NOT fail when a notification throws (safeNotify swallows it)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mockDb([[{ id: "case-1", case_number: 42 }], []]);
		vi.mocked(sendCaseCreatedAck).mockRejectedValueOnce(new Error("SES down"));
		vi.mocked(slackCaseCreated).mockRejectedValueOnce(new Error("Slack 500"));
		vi.mocked(notifySupportInboxEmail).mockRejectedValueOnce(new Error("SES down"));

		await expect(submitCase(submitInput)).resolves.toEqual({
			id: "case-1",
			caseNumber: 42,
		});
	});

	it("rejects an invalid payload before authorizing or writing", async () => {
		mockDb([[]]);
		await expect(
			submitCase({ ...submitInput, subject: "ab" } as never),
		).rejects.toThrow();
		expect(authorizeQuiet).not.toHaveBeenCalled();
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

describe("postCaseMessage — customer reply reopens settled cases", () => {
	const caseId = "11111111-1111-4111-8111-111111111111";

	/** Runs a reply against a case seeded in `status` and returns the update `.set()` payload. */
	async function replyOn(status: string) {
		const { setSpy } = mockDb([
			[{ case_number: 5, subject: "S", severity: "normal", status }], // select case
			[{ id: "msg-1" }], // insert reply … returning
			[], // update case
		]);
		await postCaseMessage({ caseId, body: "Any update?" });
		return setSpy;
	}

	it("advances a resolved case to pending_support", async () => {
		const setSpy = await replyOn("resolved");
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending_support", last_author_type: "customer" }),
		);
	});

	it("advances a closed case to pending_support", async () => {
		const setSpy = await replyOn("closed");
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending_support" }),
		);
	});

	it("advances a pending_customer case to pending_support", async () => {
		const setSpy = await replyOn("pending_customer");
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending_support" }),
		);
	});

	it("keeps an already-open case open", async () => {
		const setSpy = await replyOn("open");
		expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "open" }));
	});

	it("returns the new message id and notifies support", async () => {
		mockDb([
			[{ case_number: 5, subject: "S", severity: "normal", status: "open" }],
			[{ id: "msg-1" }],
			[],
		]);
		const res = await postCaseMessage({ caseId, body: "Any update?" });
		expect(res).toEqual({ id: "msg-1" });
		expect(authorizeQuiet).toHaveBeenCalledWith("reply", {
			type: "support_case",
			id: caseId,
		});
		expect(sendCaseRepliedEmail).toHaveBeenCalledTimes(1);
		expect(slackCaseReplied).toHaveBeenCalledWith(
			expect.objectContaining({ caseNumber: 5 }),
		);
	});

	it("throws when the case is not found (no insert)", async () => {
		const { valuesSpy } = mockDb([[]]);
		await expect(postCaseMessage({ caseId, body: "hi" })).rejects.toThrow(/Case not found/);
		expect(valuesSpy).not.toHaveBeenCalled();
	});
});

describe("transitionCase via resolve/reopen/close — assertTransition gate", () => {
	const id = "22222222-2222-4222-8222-222222222222";

	it("resolveCase moves an open case to resolved (stamps resolved_at)", async () => {
		const { setSpy } = mockDb([[{ status: "open" }], []]);
		await resolveCase(id);
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "resolved", resolved_at: expect.any(Date) }),
		);
	});

	it("closeCase moves a resolved case to closed (stamps closed_at)", async () => {
		const { setSpy } = mockDb([[{ status: "resolved" }], []]);
		await closeCase(id);
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "closed", closed_at: expect.any(Date) }),
		);
	});

	it("reopenCase moves a closed case back to open", async () => {
		const { setSpy } = mockDb([[{ status: "closed" }], []]);
		await reopenCase(id);
		expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "open" }));
	});

	it("throws on an illegal transition (closed → resolved) and does not write", async () => {
		const { setSpy } = mockDb([[{ status: "closed" }]]);
		await expect(resolveCase(id)).rejects.toThrow(
			/Illegal support-case transition: closed → resolved/,
		);
		expect(setSpy).not.toHaveBeenCalled();
	});

	it("throws when the case is missing", async () => {
		const { setSpy } = mockDb([[]]);
		await expect(resolveCase(id)).rejects.toThrow(/Case not found/);
		expect(setSpy).not.toHaveBeenCalled();
	});
});
