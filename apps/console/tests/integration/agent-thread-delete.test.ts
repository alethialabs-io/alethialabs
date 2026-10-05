// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: a thread the user deleted is never brought back by a late save, and the late turn is
// not lost either (#5423 review). Real Postgres, under the owner's RLS scope: the actions run under
// an INJECTED actor (`runWithActor`, the seam the MCP server uses), and the save runs as the chat
// routes call it. Before the tombstone, `deleteThread` removed the row outright and the late save
// recreated it under the same id — the deleted conversation reappeared in the rail.

import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import {
	createThread,
	deleteThread,
	getThread,
	listThreads,
} from "@/app/server/actions/agent";
import { saveThreadTranscript } from "@/lib/agent/thread-transcript";
import { runWithActor } from "@/lib/authz/actor-context";
import { getServiceDb } from "@/lib/db";
import { agentThreads } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// Community tenancy model: orgId === userId (personal org).
const OWNER = randomUUID();
const actor = { userId: OWNER, orgId: OWNER };

/** Run `fn` as the owner. */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
	return runWithActor(actor, fn);
}

/** A finished transcript: the first turn, its reply, and any further turns. */
function transcript(firstId: string, ...texts: string[]): UIMessage[] {
	return texts.map((text, i) => ({
		id: i === 0 ? firstId : `${firstId}-${i}`,
		role: i % 2 === 0 ? "user" : "assistant",
		parts: [{ type: "text", text }],
	}));
}

describeIfDb("agent thread delete vs. a late transcript save", () => {
	afterAll(async () => {
		await getServiceDb().delete(agentThreads).where(eq(agentThreads.user_id, OWNER));
	});

	it("a save that arrives after the delete goes into a new, listed thread; the deleted one stays deleted", async () => {
		const firstId = `m-${randomUUID()}`;
		const thread = await asOwner(() => createThread("deploy staging", undefined, { id: firstId, text: "deploy staging" }));
		await asOwner(() => deleteThread(thread.id));
		expect(await asOwner(() => getThread(thread.id))).toBeNull();

		const finished = transcript(firstId, "deploy staging", "Planned.");
		const outcome = await saveThreadTranscript(
			{ owner: OWNER, threadId: thread.id, kind: "agent", projectId: null },
			finished,
		);
		expect(outcome.kind).toBe("recovered");
		expect(await asOwner(() => getThread(thread.id))).toBeNull();

		const listed = await asOwner(() => listThreads());
		expect(listed.map((t) => t.id)).not.toContain(thread.id);
		const recovered = listed.filter((t) => t.title.startsWith("Recovered:"));
		expect(recovered).toHaveLength(1);
		expect(recovered[0].title).toBe("Recovered: deploy staging");
		expect(recovered[0].messages).toEqual(finished);

		// The next turn of the same conversation lands in that thread, not in a second one.
		const longer = transcript(firstId, "deploy staging", "Planned.", "and prod?", "Planned too.");
		const again = await saveThreadTranscript(
			{ owner: OWNER, threadId: thread.id, kind: "agent", projectId: null },
			longer,
		);
		expect(again).toEqual(outcome);
		const relisted = await asOwner(() => listThreads());
		expect(relisted.filter((t) => t.title.startsWith("Recovered:"))).toHaveLength(1);
		expect(relisted.find((t) => t.title.startsWith("Recovered:"))?.messages).toEqual(longer);

		// The tombstone carries nothing the user typed.
		const [tombstone] = await getServiceDb()
			.select()
			.from(agentThreads)
			.where(eq(agentThreads.id, thread.id));
		expect(tombstone).toMatchObject({ status: "deleted", title: "", messages: [] });
	});

	it("a save into a row that is simply gone (reaped) recreates it under the same id", async () => {
		const id = randomUUID();
		const finished = transcript(`m-${randomUUID()}`, "what failed?", "Two jobs.");
		const outcome = await saveThreadTranscript(
			{ owner: OWNER, threadId: id, kind: "agent", projectId: null },
			finished,
		);
		expect(outcome).toEqual({ kind: "recreated" });
		const row = await asOwner(() => getThread(id));
		expect(row?.messages).toEqual(finished);
	});

	it("a save never writes into another owner's thread", async () => {
		const other = randomUUID();
		const [theirs] = await getServiceDb()
			.insert(agentThreads)
			.values({ user_id: other, org_id: other, title: "theirs" })
			.returning({ id: agentThreads.id });
		try {
			await expect(
				saveThreadTranscript(
					{ owner: OWNER, threadId: theirs.id, kind: "agent", projectId: null },
					transcript(`m-${randomUUID()}`, "hi", "hello"),
				),
			).rejects.toThrow(/could not be saved/);
			const [row] = await getServiceDb()
				.select()
				.from(agentThreads)
				.where(eq(agentThreads.id, theirs.id));
			expect(row.messages).toEqual([]);
		} finally {
			await getServiceDb().delete(agentThreads).where(eq(agentThreads.user_id, other));
		}
	});
});
