// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: a thread the user deleted is never brought back by a late save, and the late turn is
// not lost either (#5423 review). Real Postgres: the actions run under the owner's RLS scope through
// an INJECTED actor (`runWithActor`, the seam the MCP server uses), and the late save runs as
// `finalizeTurn`'s `deleted` outcome does — `recoverTranscript` over `transcriptRows` on a
// service-role transaction. Before the tombstone, `deleteThread` removed the row outright and the
// late save recreated it under the same id — the deleted conversation reappeared in the rail. (A
// NEW turn into a reaped id recreating the thread is `reserveTurn`'s, and is tested in
// `agent-turn-claims.test.ts`.)

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
import { transcriptRows } from "@/lib/agent/thread-transcript";
import { recoverTranscript, type TranscriptTarget } from "@/lib/agent/transcript-save";
import { runWithActor } from "@/lib/authz/actor-context";
import { getServiceDb } from "@/lib/db";
import { agentThreads } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// Community tenancy model: orgId === userId (personal org).
const OWNER = randomUUID();
const actor = { userId: OWNER, orgId: OWNER, credential: "session" as const };

/** Run `fn` as the owner. */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
	return runWithActor(actor, fn);
}

/** Save a late turn's transcript as `finalizeTurn` does when it finds its thread deleted. */
function lateSave(target: TranscriptTarget, messages: UIMessage[]) {
	return getServiceDb().transaction((tx) => recoverTranscript(transcriptRows(tx, target.owner), target, messages));
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
		const outcome = await lateSave(
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
		const again = await lateSave(
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

	it("a save never writes into another owner's thread", async () => {
		const other = randomUUID();
		const [theirs] = await getServiceDb()
			.insert(agentThreads)
			.values({ user_id: other, org_id: other, title: "theirs" })
			.returning({ id: agentThreads.id });
		try {
			const outcome = await lateSave(
				{ owner: OWNER, threadId: theirs.id, kind: "agent", projectId: null },
				transcript(`m-${randomUUID()}`, "hi", "hello"),
			);
			expect(outcome.threadId).not.toBe(theirs.id);
			const [row] = await getServiceDb()
				.select()
				.from(agentThreads)
				.where(eq(agentThreads.id, theirs.id));
			expect(row.messages).toEqual([]);
			const [mine] = await getServiceDb()
				.select()
				.from(agentThreads)
				.where(eq(agentThreads.id, outcome.threadId));
			expect(mine.user_id).toBe(OWNER);
		} finally {
			await getServiceDb().delete(agentThreads).where(eq(agentThreads.user_id, other));
		}
	});
});
