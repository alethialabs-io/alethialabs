// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-key write queue of Elench drafts (ADR 0001 §7.1, D29, D32, I10).
//
// One lane per key holds at most ONE request on the wire; the next waits. Every request takes its
// sequence number from the store's one per-tab counter when it is SENT, not when it is queued. A
// request is sent only while the page shows the key's org (`pageOrg`, D29); otherwise it waits in
// its lane and nothing is POSTed until `pump` finds the page on that org again.
//
// Every request has a client timeout: 30 s for `startConversation`, 15 s for every other write. A
// server action cannot be cancelled, so a timeout ABANDONS the request (D32): the lane is freed at
// once, the failure is reported, and the late answer is dropped. Abandoning is always safe, because
// no draft write is blind (a save is a compare-and-set, and every claim write names a token).
//
// Coalescing edits into the next save is the reducer's: it never asks for a second save of a key
// while one is unanswered (`inflight`), so this queue never has to merge two.

/** The client timeout of every draft write but a start (§7.1). */
export const WRITE_TIMEOUT_MS = 15_000;

/** The client timeout of `startConversation` (§7.1, Q9). */
export const START_TIMEOUT_MS = 30_000;

/** How a request ended without an answer: rejected (D27) or abandoned at its timeout (D32). */
export type QueueFailure = { kind: "rejected"; network: boolean } | { kind: "timeout" };

/** One write, typed by its answer. */
export interface QueuedWrite<T> {
	/** The key's org: the request is sent only while the page shows it (D29). */
	orgId: string;
	timeoutMs: number;
	send: () => Promise<T>;
	/** The answer, numbered with the sequence number the request took when it was sent. */
	answer: (seq: number, value: T) => void;
	/** No answer: a rejected call or the timeout. Never called after `answer`, and never twice. */
	fail: (seq: number, failure: QueueFailure) => void;
}

/** A write with its answer type erased, so one lane can hold writes of every action. */
interface LaneItem {
	orgId: string;
	start: (seq: number, done: () => boolean) => Promise<void>;
	timeout: (seq: number) => void;
	timeoutMs: number;
}

/** One key's lane: the writes waiting, and whether one is on the wire. */
interface Lane {
	waiting: LaneItem[];
	busy: boolean;
}

/**
 * True when a rejected action call is a network failure (offline, or the `fetch` under the call
 * failed), which D27 treats as transient. Any other rejection is an error, retried at most three times.
 */
function isNetworkFailure(e: unknown): boolean {
	if (e instanceof TypeError) return true;
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** The per-key queue (§7.1). */
export class DraftWriteQueue {
	private lanes = new Map<string, Lane>();

	/** `nextSeq` is the store's per-tab counter; `pageOrg` is read when a request would be sent. */
	constructor(
		private readonly nextSeq: () => number,
		private readonly pageOrg: () => string | null,
	) {}

	/** Queues one write in the lane `laneId` (a key id) and sends it when the lane and the page allow. */
	enqueue<T>(laneId: string, write: QueuedWrite<T>): void {
		const item: LaneItem = {
			orgId: write.orgId,
			timeoutMs: write.timeoutMs,
			timeout: (seq) => write.fail(seq, { kind: "timeout" }),
			start: (seq, done) => {
				let sent: Promise<T>;
				try {
					sent = write.send();
				} catch (e) {
					sent = Promise.reject(e);
				}
				return sent.then(
					(value) => {
						if (done()) write.answer(seq, value);
					},
					(e: unknown) => {
						if (done()) write.fail(seq, { kind: "rejected", network: isNetworkFailure(e) });
					},
				);
			},
		};
		const lane = this.lanes.get(laneId) ?? { waiting: [], busy: false };
		lane.waiting.push(item);
		this.lanes.set(laneId, lane);
		this.pump(laneId);
	}

	/** Sends the head of every lane that can go now: after a write settles, and on `PAGE_ORG` (D29). */
	pumpAll(): void {
		for (const id of [...this.lanes.keys()]) this.pump(id);
	}

	/** Drops every waiting write (D25). Writes on the wire cannot be cancelled; their answers are dropped. */
	clear(): void {
		this.lanes = new Map();
	}

	/** True when lane `laneId` holds nothing, on the wire or waiting. */
	idle(laneId: string): boolean {
		const lane = this.lanes.get(laneId);
		return lane === undefined || (!lane.busy && lane.waiting.length === 0);
	}

	/** Sends lane `laneId`'s head when nothing of the lane is on the wire and the page shows its org. */
	private pump(laneId: string): void {
		const lane = this.lanes.get(laneId);
		if (lane === undefined || lane.busy) return;
		const head = lane.waiting[0];
		if (head === undefined) {
			this.lanes.delete(laneId);
			return;
		}
		if (this.pageOrg() !== head.orgId) return; // held (D29): nothing is POSTed
		lane.waiting.shift();
		lane.busy = true;
		const seq = this.nextSeq();
		let open = true;
		const done = (): boolean => {
			if (!open) return false; // abandoned at its timeout, or already answered: dropped (D32)
			open = false;
			clearTimeout(timer);
			lane.busy = false;
			return this.lanes.get(laneId) === lane; // a clear() (D25) drops the answer too
		};
		const timer = setTimeout(() => {
			if (done()) head.timeout(seq);
			this.pump(laneId);
		}, head.timeoutMs);
		void head.start(seq, done).then(() => this.pump(laneId));
	}
}
