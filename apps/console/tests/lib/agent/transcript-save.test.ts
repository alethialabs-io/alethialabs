// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A chat route's finished turn is saved without losing it and without undoing the user's delete
// (#5423 review). `saveTranscript` runs here over an in-memory table that behaves as the owner's
// rows do: an update matches only a live row of its kind, an insert under an id already held does
// nothing. The drizzle side of each operation, and the route wiring, are covered by
// tests/lib/agent/thread-transcript.test.ts and tests/integration/agent-thread-delete.test.ts.

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	saveTranscript,
	THREAD_DELETED,
	type TranscriptRows,
	type TranscriptTarget,
} from "@/lib/agent/transcript-save";

interface Row {
	id: string;
	title: string;
	kind: string;
	status: string;
	projectId: string | null;
	messages: UIMessage[];
}

/** The owner's rows, in memory. `hidden` ids are held by rows this owner cannot see. */
function table(rows: Row[] = [], hidden: string[] = []) {
	let minted = 0;
	const impl: TranscriptRows = {
		async updateLive(id, kind, projectId, messages) {
			const row = rows.find(
				(r) => r.id === id && r.kind === kind && r.projectId === projectId && r.status !== THREAD_DELETED,
			);
			if (!row) return false;
			row.messages = messages;
			return true;
		},
		async find(id) {
			const row = rows.find((r) => r.id === id);
			return row ? { status: row.status } : null;
		},
		async findRecovered(deletedId, kind, projectId, firstMessageId) {
			const row = rows.find(
				(r) =>
					r.id !== deletedId &&
					r.kind === kind &&
					r.projectId === projectId &&
					r.status !== THREAD_DELETED &&
					r.messages[0]?.id === firstMessageId,
			);
			return row?.id ?? null;
		},
		async insert(row) {
			const id = row.id ?? `00000000-0000-4000-8000-${String((minted += 1)).padStart(12, "0")}`;
			if (hidden.includes(id) || rows.some((r) => r.id === id)) return null;
			rows.push({ ...row, id, status: "active" });
			return id;
		},
	};
	return { rows, impl };
}

const T = "5b0f4f0e-6c43-4f39-9a52-0a0f6f2a6b11";
const target: TranscriptTarget = { owner: "user-1", threadId: T, kind: "agent", projectId: null };

/** A transcript: the user's first message, then a reply per extra turn. */
function transcript(...texts: string[]): UIMessage[] {
	return texts.map((text, i) => ({
		id: `m-${i}`,
		role: i % 2 === 0 ? "user" : "assistant",
		parts: [{ type: "text", text }],
	}));
}

describe("saveTranscript", () => {
	it("writes over the live thread", async () => {
		const { rows, impl } = table([
			{ id: T, title: "t", kind: "agent", status: "active", projectId: null, messages: [] },
		]);
		const messages = transcript("what failed?", "Two jobs.");
		expect(await saveTranscript(impl, target, messages)).toEqual({ kind: "saved" });
		expect(rows).toHaveLength(1);
		expect(rows[0].messages).toBe(messages);
	});

	it("recreates a reaped thread under its own id, in the route's project", async () => {
		const { rows, impl } = table();
		const messages = transcript("  what   failed?  ", "Two jobs.");
		const p = "7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
		expect(await saveTranscript(impl, { ...target, projectId: p }, messages)).toEqual({
			kind: "recreated",
		});
		expect(rows).toEqual([
			{ id: T, title: "what failed?", kind: "agent", status: "active", projectId: p, messages },
		]);
	});

	// The defect the tombstone exists for: the late save recreated the row the user deleted.
	it("never brings back a thread the user deleted: the turn goes into a new, recovered thread", async () => {
		const { rows, impl } = table([
			{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] },
		]);
		const messages = transcript("deploy staging", "Planned.");
		const outcome = await saveTranscript(impl, target, messages);
		expect(outcome.kind).toBe("recovered");
		const tombstone = rows.find((r) => r.id === T);
		expect(tombstone).toMatchObject({ status: THREAD_DELETED, messages: [], title: "" });
		const recovered = rows.filter((r) => r.id !== T);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({
			title: "Recovered: deploy staging",
			status: "active",
			kind: "agent",
			messages,
		});
		expect(outcome).toEqual({ kind: "recovered", threadId: recovered[0].id });
	});

	it("saves the next turn of that conversation into the same recovered thread", async () => {
		const { rows, impl } = table([
			{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] },
		]);
		const first = await saveTranscript(impl, target, transcript("deploy staging", "Planned."));
		const longer = transcript("deploy staging", "Planned.", "and prod?", "Planned too.");
		const second = await saveTranscript(impl, target, longer);
		expect(second).toEqual(first);
		const recovered = rows.filter((r) => r.id !== T);
		expect(recovered).toHaveLength(1);
		expect(recovered[0].messages).toBe(longer);
	});

	it("does not create a support thread: no client creates one, so a missing one is not saved", async () => {
		const { rows, impl } = table();
		await expect(
			saveTranscript(impl, { ...target, kind: "support" }, transcript("hi", "hello")),
		).rejects.toThrow(/no such support thread/);
		expect(rows).toEqual([]);
	});

	it("never overwrites a row of another kind under the same id", async () => {
		const { rows, impl } = table([
			{ id: T, title: "s", kind: "support", status: "active", projectId: null, messages: [] },
		]);
		await expect(saveTranscript(impl, target, transcript("hi", "hello"))).rejects.toThrow(
			/could not be saved/,
		);
		expect(rows[0].messages).toEqual([]);
	});

	it("fails loudly when a deleted thread's transcript cannot be recovered, and writes nothing", async () => {
		// The first id the in-memory table mints for an id-less insert is held by a row this owner
		// cannot see, so the recovery insert comes back null.
		const { rows, impl } = table(
			[{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] }],
			["00000000-0000-4000-8000-000000000001"],
		);
		await expect(saveTranscript(impl, target, transcript("deploy staging", "Planned."))).rejects.toThrow(
			`Thread ${T} was deleted and its transcript could not be recovered.`,
		);
		expect(rows).toEqual([
			{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] },
		]);
	});

	it("titles a recovered thread from its text alone, and plainly when no user message is held", async () => {
		const { rows, impl } = table([
			{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] },
		]);
		const replyOnly: UIMessage[] = [{ id: "a-0", role: "assistant", parts: [{ type: "text", text: "Planned." }] }];
		const outcome = await saveTranscript(impl, target, replyOnly);
		expect(outcome.kind).toBe("recovered");
		expect(rows.filter((r) => r.id !== T)).toEqual([
			expect.objectContaining({ title: "Recovered:", messages: replyOnly }),
		]);

		const { rows: second, impl: secondImpl } = table([
			{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] },
		]);
		const withFile: UIMessage[] = [
			{
				id: "u-0",
				role: "user",
				parts: [
					{ type: "file", mediaType: "text/plain", url: "data:text/plain,x" },
					{ type: "text", text: "read this" },
				],
			},
		];
		await saveTranscript(secondImpl, target, withFile);
		expect(second.filter((r) => r.id !== T)[0].title).toBe("Recovered: read this");
	});

	it("does not look up an earlier recovery for an empty transcript, and still keeps it", async () => {
		const { rows, impl } = table([
			{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] },
			// A live thread a lookup with an undefined first-message id would wrongly match.
			{ id: "11111111-1111-4111-8111-111111111111", title: "x", kind: "agent", status: "active", projectId: null, messages: [] },
		]);
		const outcome = await saveTranscript(impl, target, []);
		expect(outcome.kind).toBe("recovered");
		expect(outcome).not.toEqual({ kind: "recovered", threadId: "11111111-1111-4111-8111-111111111111" });
		expect(rows).toHaveLength(3);
	});

	it("recovers into a new thread when the earlier recovered thread stops matching before the write", async () => {
		const earlierId = "22222222-2222-4222-8222-222222222222";
		const { rows, impl } = table([
			{ id: T, title: "", kind: "agent", status: THREAD_DELETED, projectId: null, messages: [] },
			{ id: earlierId, title: "Recovered: deploy staging", kind: "agent", status: "active", projectId: null, messages: transcript("deploy staging") },
		]);
		// The earlier thread is deleted between the lookup and the update: the update must not write
		// over it, and the turn still lands in a thread the rail lists.
		const racing: TranscriptRows = {
			...impl,
			async findRecovered(...args) {
				const id = await impl.findRecovered(...args);
				const row = rows.find((r) => r.id === id);
				if (row) row.status = THREAD_DELETED;
				return id;
			},
		};
		const messages = transcript("deploy staging", "Planned.");
		const outcome = await saveTranscript(racing, target, messages);
		expect(outcome.kind).toBe("recovered");
		expect(outcome).not.toEqual({ kind: "recovered", threadId: earlierId });
		expect(rows.find((r) => r.id === earlierId)?.messages).toEqual(transcript("deploy staging"));
		expect(rows.filter((r) => r.status === "active")).toEqual([expect.objectContaining({ messages })]);
	});

	it("fails loudly when the id is held by a row this owner cannot see", async () => {
		const { rows, impl } = table([], [T]);
		await expect(saveTranscript(impl, target, transcript("hi", "hello"))).rejects.toThrow(
			/not this owner's/,
		);
		expect(rows).toEqual([]);
	});
});
