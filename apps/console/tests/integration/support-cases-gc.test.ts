// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7220: support cases are deleted 3 years after the matter closes (`gcSupportCases`,
// lib/reconcile/gc.ts), against a real Postgres, because the predicate is SQL and the cascade is the
// schema's:
//   - a case closed 3 years and a day ago goes, with its messages, attachment rows and files;
//   - one closed 3 years less a day ago stays, and so does an open case however old;
//   - a reopened-then-resolved case is aged from its NEW resolution, not the stale closed_at;
//   - a case whose file will not delete stays, so its row still names the file for the next run.

import { randomUUID } from "node:crypto";
import { eq, inArray, type SQL, sql } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	type NewSupportCase,
	supportCaseAttachments,
	supportCases,
	supportMessages,
} from "@/lib/db/schema";
import { gcSupportCases, SUPPORT_CASE_RETENTION_DAYS } from "@/lib/reconcile/gc";
import { describeIfDb } from "./db";

const created: string[] = [];

/** A support case row for a fresh user, `status` as given. */
function caseRow(status: NewSupportCase["status"]): NewSupportCase {
	return {
		user_id: randomUUID(),
		org_id: randomUUID(),
		type: "technical",
		category: "other",
		status,
		subject: "Retention fixture",
		contact: { notifyEmail: "retention@example.test", channel: "email" },
	};
}

/** Inserts a case with one message and `files` attachments, then backdates the columns `ages` names. */
async function insertCase(
	status: NewSupportCase["status"],
	ages: Partial<Record<"closed_at" | "resolved_at" | "last_message_at" | "updated_at", SQL>>,
	files = 0,
): Promise<{ id: string; keys: string[] }> {
	const db = getServiceDb();
	const [row] = await db.insert(supportCases).values(caseRow(status)).returning({ id: supportCases.id });
	if (!row) throw new Error("no case inserted");
	created.push(row.id);
	await db.insert(supportMessages).values({ case_id: row.id, author_type: "customer", body: "It broke." });
	const keys = Array.from({ length: files }, (_, i) => `support/test/${row.id}/${i}/log.txt`);
	if (keys.length > 0) {
		await db.insert(supportCaseAttachments).values(
			keys.map((key) => ({
				case_id: row.id,
				uploaded_by: randomUUID(),
				file_name: "log.txt",
				content_type: "text/plain",
				size_bytes: 10,
				storage_key: key,
			})),
		);
	}
	if (Object.keys(ages).length > 0) await db.update(supportCases).set(ages).where(eq(supportCases.id, row.id));
	return { id: row.id, keys };
}

/** Whether the case with `id` still exists. */
async function exists(id: string): Promise<boolean> {
	const rows = await getServiceDb().select({ id: supportCases.id }).from(supportCases).where(eq(supportCases.id, id));
	return rows.length > 0;
}

const ago = (interval: string): SQL => sql`now() - ${interval}::interval`;
// A day either side of the enforced window, which is read from the module under test.
const OLD = ago(`${SUPPORT_CASE_RETENTION_DAYS + 1} days`);
const RECENT = ago(`${SUPPORT_CASE_RETENTION_DAYS - 1} days`);

describeIfDb("the support-case retention sweep against Postgres", () => {
	afterAll(async () => {
		if (created.length > 0) await getServiceDb().delete(supportCases).where(inArray(supportCases.id, created));
	});

	it("enforces the published window: 3 years (1095 days) after the matter closes", () => {
		expect(SUPPORT_CASE_RETENTION_DAYS).toBe(1095);
	});

	it("deletes a case closed 3 years and a day ago, with its thread and its files", async () => {
		const gone = await insertCase("closed", { closed_at: OLD, last_message_at: OLD, updated_at: OLD }, 2);
		const kept = await insertCase("closed", { closed_at: RECENT, last_message_at: RECENT, updated_at: RECENT });
		const files = { del: vi.fn(async () => undefined) };
		const result = await gcSupportCases(getServiceDb(), files);
		expect(await exists(gone.id)).toBe(false);
		expect(await exists(kept.id)).toBe(true);
		for (const key of gone.keys) expect(files.del).toHaveBeenCalledWith("support-attachments", key);
		const messages = await getServiceDb()
			.select({ id: supportMessages.id })
			.from(supportMessages)
			.where(eq(supportMessages.case_id, gone.id));
		expect(messages).toEqual([]);
		expect(result.deleted).toBeGreaterThanOrEqual(1);
	});

	it("never deletes an open case, however old", async () => {
		const open = await insertCase("open", { last_message_at: OLD, updated_at: OLD });
		await gcSupportCases(getServiceDb(), { del: async () => undefined });
		expect(await exists(open.id)).toBe(true);
	});

	it("ages a reopened-then-resolved case from its new resolution, not the stale closed_at", async () => {
		const resolved = await insertCase("resolved", {
			closed_at: OLD,
			resolved_at: RECENT,
			last_message_at: OLD,
			updated_at: RECENT,
		});
		await gcSupportCases(getServiceDb(), { del: async () => undefined });
		expect(await exists(resolved.id)).toBe(true);
	});

	it("keeps a case whose file will not delete, so the next run can retry it", async () => {
		const stuck = await insertCase("closed", { closed_at: OLD, last_message_at: OLD, updated_at: OLD }, 1);
		const result = await gcSupportCases(getServiceDb(), {
			del: async () => {
				throw new Error("storage down");
			},
		});
		expect(await exists(stuck.id)).toBe(true);
		expect(result.storageFailed).toBeGreaterThanOrEqual(1);
	});
});
