// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for `requestMyErasure` (#4273): the account dialog's "Request deletion".
//
// What is pinned, because each is a property the action's doc comment claims:
//   · the subject is the SESSION's user — the action takes no arguments, and the row it writes names
//     the session's id and the hash of the session's address;
//   · an injected (token) actor is refused before the session is even read;
//   · no session → refused, and nothing is written;
//   · the case is opened as an ERASURE, pre-verified (`identityVerifiedAt` set, `in_review`), with no
//     organization, and the ledger records BOTH the receipt and that the session was the check;
//   · an erasure case already open for the same user is returned instead of a second being opened;
//   · the "still open" filter excludes exactly the finished states — asserted on the SQL the where
//     clause renders, not on the mock's say-so;
//   · a new case is EMAILED to the privacy inbox, inside the transaction that writes it, so a failed
//     send leaves no case behind (#4875). The transaction mock below holds its writes back and only
//     records them when the callback resolves — which is what a rollback looks like from outside;
//   · with no inbox to send to (self-managed, no PRIVACY_EMAIL) no case is opened at all, and a
//     self-managed deployment is never routed to Alethia's own inbox.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, injected, sendEmail, mode } = vi.hoisted(() => ({
	getSession: vi.fn(),
	injected: vi.fn(),
	sendEmail: vi.fn(),
	mode: vi.fn(),
}));
vi.mock("@repo/email/send", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@repo/email/config", () => ({ getEmailConfig: () => ({ from: { general: "Alethia <hello@example.io>" } }) }));
vi.mock("@/lib/billing/config", () => ({ deploymentMode: () => mode() }));
// The template is replaced by one that hands back its props, so a test can read what the email was
// told. `subject` stays real: the reference in the subject line is part of what is asserted.
vi.mock("@/emails/privacy-request", async (importActual) => {
	const actual = await importActual<typeof import("@/emails/privacy-request")>();
	return { subject: actual.subject, PrivacyRequestEmail: (props: unknown) => ({ props }) };
});
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: () => injected() }));

/** Every write and read the action makes, in order, so a test can assert on what reached the DB. */
const calls: { op: string; table?: unknown; values?: unknown; where?: SQL }[] = [];
/** The rows the "is one already open?" read returns. */
let existing: { reference: string }[] = [];

/** An insert builder that records into `sink`, awaitable bare or through `.returning()`. */
function insertInto(sink: typeof calls) {
	return (table: unknown) => ({
		values: (values: unknown) => {
			sink.push({ op: "insert", table, values });
			const done = Promise.resolve(undefined);
			return Object.assign(done, {
				returning: async () => [{ id: "case-1" }],
			});
		},
	});
}

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: (where: SQL) => ({
					limit: async () => {
						calls.push({ op: "select", table, where });
						return existing;
					},
				}),
			}),
		}),
		insert: insertInto(calls),
		// Writes made through `tx` reach `calls` only if the callback resolves: a callback that
		// throws leaves nothing behind, as a rolled-back transaction does.
		transaction: async (cb: (tx: { insert: ReturnType<typeof insertInto> }) => Promise<unknown>) => {
			const pending: typeof calls = [];
			const out = await cb({ insert: insertInto(pending) });
			calls.push(...pending);
			return out;
		},
	}),
}));

import { requestMyErasure } from "@/app/server/actions/privacy/self-serve";
import { subjectHash } from "@/app/server/actions/privacy/ledger";
import { privacyCase, privacyCaseEvent } from "@/lib/db/schema";

const SESSION = { user: { id: "user-1", email: "Ada@Example.io" } };

beforeEach(() => {
	calls.length = 0;
	existing = [];
	getSession.mockReset();
	injected.mockReset();
	injected.mockReturnValue(undefined);
	getSession.mockResolvedValue(SESSION);
	sendEmail.mockReset();
	sendEmail.mockResolvedValue(undefined);
	mode.mockReset();
	mode.mockReturnValue("hosted");
	delete process.env.PRIVACY_EMAIL;
});

/** The values object of every insert into `table`, in order. */
function inserts(table: unknown): unknown[] {
	return calls.filter((c) => c.op === "insert" && c.table === table).map((c) => c.values);
}

describe("requestMyErasure", () => {
	it("opens a pre-verified erasure case about the SESSION's user, with no organization", async () => {
		const before = Date.now();
		const out = await requestMyErasure();

		if (out.outcome !== "opened") throw new Error(`expected a case to be opened, got ${out.outcome}`);
		expect(out.reference).toMatch(/^DSR-[0-9A-F]{8}$/);

		const [row] = inserts(privacyCase);
		expect(row).toMatchObject({
			reference: out.reference,
			kind: "erasure",
			state: "in_review",
			subjectUserId: "user-1",
			subjectEmailSha256: subjectHash("ada@example.io"),
			organizationId: null,
		});
		// Identity is recorded as verified AT RECEIPT, and the deadline is 30 days from it.
		expect(row).toHaveProperty("identityVerifiedAt");
		expect(row).toHaveProperty("receivedAt");
		expect(row).toHaveProperty("dueAt");
		if (!row || typeof row !== "object" || !("receivedAt" in row) || !("dueAt" in row) || !("identityVerifiedAt" in row)) {
			throw new Error("the case row is missing its timestamps");
		}
		const { receivedAt, dueAt, identityVerifiedAt } = row;
		if (!(receivedAt instanceof Date) || !(dueAt instanceof Date) || !(identityVerifiedAt instanceof Date)) {
			throw new Error("the case timestamps are not Dates");
		}
		expect(receivedAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(identityVerifiedAt.getTime()).toBe(receivedAt.getTime());
		expect(dueAt.getTime() - receivedAt.getTime()).toBe(30 * 86_400_000);
	});

	it("records the receipt AND that the session was the identity check, both by the subject", async () => {
		await requestMyErasure();
		const events = inserts(privacyCaseEvent);
		expect(events).toEqual([
			expect.objectContaining({ caseId: "case-1", kind: "received", actorUserId: "user-1" }),
			expect.objectContaining({
				caseId: "case-1",
				kind: "identity_verified",
				actorUserId: "user-1",
				detail: expect.objectContaining({
					summary: expect.stringMatching(/authenticated console session/),
				}),
			}),
		]);
		// And it says nothing was erased — the ledger must not read as a fulfilment.
		const summaries = JSON.stringify(events);
		expect(summaries).toMatch(/Nothing has been erased/);
		expect(summaries).not.toMatch(/Erasure performed/);
	});

	it("returns the OPEN case instead of opening a second one", async () => {
		existing = [{ reference: "DSR-ABCDEF12" }];
		await expect(requestMyErasure()).resolves.toEqual({ reference: "DSR-ABCDEF12", outcome: "already_open" });
		expect(inserts(privacyCase)).toEqual([]);
		expect(inserts(privacyCaseEvent)).toEqual([]);
		// It was emailed when it was opened; a second press does not email it again.
		expect(sendEmail).not.toHaveBeenCalled();
	});

	// ── the hand-off to a person (#4875) ─────────────────────────────────────────────────────────

	it("emails the new case to the hosted privacy inbox, quoting its reference and the subject", async () => {
		const out = await requestMyErasure();
		if (out.outcome !== "opened") throw new Error(`expected a case to be opened, got ${out.outcome}`);
		expect(sendEmail).toHaveBeenCalledTimes(1);
		const [args] = sendEmail.mock.calls[0] ?? [];
		expect(args).toMatchObject({
			to: "privacy@alethialabs.io",
			subject: expect.stringContaining(out.reference),
		});
		expect(args).toHaveProperty("react.props", expect.objectContaining({
			reference: out.reference,
			subjectUserId: "user-1",
			subjectEmail: "Ada@Example.io",
		}));
	});

	it("sends to PRIVACY_EMAIL when it is set, on either kind of deployment", async () => {
		process.env.PRIVACY_EMAIL = " dpo@operator.example ";
		mode.mockReturnValue("self-managed");
		const out = await requestMyErasure();
		expect(out.outcome).toBe("opened");
		expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "dpo@operator.example" }));
	});

	it("opens NO case on a self-managed deployment with no PRIVACY_EMAIL — and never falls back to Alethia's inbox", async () => {
		mode.mockReturnValue("self-managed");
		await expect(requestMyErasure()).resolves.toEqual({ outcome: "no_privacy_contact" });
		expect(inserts(privacyCase)).toEqual([]);
		expect(inserts(privacyCaseEvent)).toEqual([]);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("leaves no case and no ledger event behind when the email fails", async () => {
		sendEmail.mockRejectedValue(new Error("SES said no"));
		await expect(requestMyErasure()).rejects.toThrow(/SES said no/);
		expect(inserts(privacyCase)).toEqual([]);
		expect(inserts(privacyCaseEvent)).toEqual([]);
	});

	it("looks for an open case of THIS user, of kind erasure, excluding exactly the finished states", async () => {
		await requestMyErasure();
		const read = calls.find((c) => c.op === "select");
		expect(read?.table).toBe(privacyCase);
		if (!read?.where) throw new Error("the open-case read carried no where clause");
		const { sql, params } = new PgDialect({ casing: "snake_case" }).sqlToQuery(read.where);
		expect(sql).toMatch(/"subject_user_id" = \$1/);
		expect(sql).toMatch(/"kind" = \$2/);
		expect(sql).toMatch(/"state" not in \(\$3, \$4, \$5\)/);
		expect(params).toEqual(["user-1", "erasure", "fulfilled", "refused", "withdrawn"]);
	});

	it("refuses with no session, and writes nothing", async () => {
		getSession.mockResolvedValue(null);
		await expect(requestMyErasure()).rejects.toThrow(/Unauthorized/);
		expect(calls).toEqual([]);
	});

	it("refuses an injected (token) actor BEFORE reading any session", async () => {
		injected.mockReturnValue({ userId: "user-1", orgId: "user-1" });
		await expect(requestMyErasure()).rejects.toThrow(/signed-in console session/);
		expect(getSession).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("takes no arguments — there is no parameter through which to name another subject", () => {
		expect(requestMyErasure.length).toBe(0);
	});
});
