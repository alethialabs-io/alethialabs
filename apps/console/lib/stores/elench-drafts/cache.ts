// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `sessionStorage` cache of Elench drafts (ADR 0001 §7.3, I4, D26).
//
// The server row is the truth; this cache holds a key's words only while the server has not
// acknowledged them (I4): unsaved edits with their base revision, and a claim or a send with its
// token, so a reload can release its own claim (D26). One item per key:
//
//   alethia:elench:v3:<viewerId>:<orgId>:<anchor>:<conversationId>
//     = { base, local, claiming, sending, abandoned, epoch }      (zod-validated on read)
//
// and the active conversation of each scope, which holds no words, under
// `alethia:elench:v3:active:<viewerId>:<orgId>:<anchor>`.
//
// The cache is OPTIONAL. A storage getter that throws (a `SecurityError`), a write that throws (the
// quota) and a write that would take the Elench items past the 1,000,000-code-unit budget (counted
// in JSON units) are all refused the same way: `write` answers false, nothing is retried, and nothing
// else is evicted, so Elench never takes room from the canvas draft or a pending paid setup (G7).
// A credential-looking draft held from the server (D36) IS cached: the ADR keeps those words "in
// memory and the cache" until the user answers, and the tab's own storage is not the account.

import { z } from "zod";
import { contentSchema } from "@/lib/elench/draft-content";
import { keyId, scopeId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { CachedDraft } from "@/lib/stores/elench-drafts/reducer-sending";
import type { DraftEntry, DraftKey, DraftScope } from "@/lib/stores/elench-drafts/types";

/** Every Elench draft item starts with this. */
export const CACHE_PREFIX = "alethia:elench:v3:";

/** The most code units, in JSON, every Elench item together may hold (I4). */
export const CACHE_BUDGET = 1_000_000;

/** The single item of the v1 store, removed at the first LOAD (§7.3). */
const LEGACY_V1 = "alethia:elench:drafts:v1";

/** The per-key items of the v2 store, removed at the first LOAD (§7.3). */
const LEGACY_V2_PREFIX = "alethia:elench:draft:v2:";

/** The prefix of the active-conversation items (they hold no words). */
const ACTIVE_PREFIX = `${CACHE_PREFIX}active:`;

const kindSchema = z.enum(["first", "later"]);

const claimingSchema = z.object({
	attempt: z.string(),
	token: z.string(),
	turnId: z.string(),
	kind: kindSchema,
	content: contentSchema,
});

const sendingSchema = z.object({
	attempt: z.string(),
	token: z.string().nullable(),
	turnId: z.string(),
	kind: kindSchema,
	text: z.string(),
	mentions: contentSchema.shape.mentions,
	cellTarget: contentSchema.shape.cellTarget,
	origin: z.string(),
	at: z.number(),
	phase: z.enum(["starting", "routing", "consuming", "releasing"]),
});

/** One key's item, as it is written and read. */
const itemSchema = z.object({
	base: z.number().int().min(0),
	local: contentSchema.nullable(),
	claiming: claimingSchema.nullable(),
	sending: sendingSchema.nullable(),
	abandoned: z.array(z.string()),
	epoch: z.number().int(),
});

/** True while I4 lets this key keep an item: something of it is unacknowledged. */
export function cacheable(entry: DraftEntry): boolean {
	return (
		entry.local !== null ||
		entry.claiming !== null ||
		entry.sending !== null ||
		entry.pendingFailedSend !== null
	);
}

/** The item of one key of one viewer. */
function itemKey(viewerId: string, key: DraftKey): string {
	return `${CACHE_PREFIX}${viewerId}:${keyId(key)}`;
}

/** The cache over a storage that may be missing, or may throw on any access. */
export class DraftCache {
	/** `storage` is called on every access, because reading `window.sessionStorage` itself can throw. */
	constructor(private readonly storage: () => Storage | null) {}

	/** The storage, or null when it is missing or its getter throws. */
	private store(): Storage | null {
		try {
			return this.storage();
		} catch {
			return null;
		}
	}

	/** Every item name in the storage; empty when it cannot be read. */
	private names(s: Storage): string[] {
		try {
			const out: string[] = [];
			for (let i = 0; i < s.length; i++) {
				const name = s.key(i);
				if (name !== null) out.push(name);
			}
			return out;
		} catch {
			return [];
		}
	}

	/** Removes one item; a storage that throws is ignored (the cache is optional). */
	private drop(s: Storage, name: string): void {
		try {
			s.removeItem(name);
		} catch {
			// nothing to keep
		}
	}

	/**
	 * Writes `entry`'s item. False when the write is refused: no storage, a throw, or the budget.
	 * A refused write is not retried, and removes nothing.
	 */
	write(viewerId: string, entry: DraftEntry): boolean {
		const s = this.store();
		if (s === null) return false;
		const name = itemKey(viewerId, entry.key);
		const value = JSON.stringify({
			base: entry.server?.revision ?? 0,
			local: entry.local,
			claiming: entry.claiming,
			sending: entry.sending,
			abandoned: entry.abandoned,
			epoch: entry.epoch,
		});
		try {
			let used = name.length + value.length;
			for (const other of this.names(s)) {
				if (other === name || !other.startsWith(CACHE_PREFIX)) continue;
				used += other.length + (s.getItem(other)?.length ?? 0);
			}
			if (used > CACHE_BUDGET) return false;
			s.setItem(name, value);
			return true;
		} catch {
			return false;
		}
	}

	/** Removes one key's item (I4: on acknowledgement, and when a send's outcome is read). */
	remove(viewerId: string, key: DraftKey): void {
		const s = this.store();
		if (s !== null) this.drop(s, itemKey(viewerId, key));
	}

	/** D25: every Elench item, of every viewer. */
	clearAll(): void {
		const s = this.store();
		if (s === null) return;
		for (const name of this.names(s)) if (name.startsWith(CACHE_PREFIX)) this.drop(s, name);
	}

	/** D26 / §7.3, at LOAD: the v1 and v2 items, and the items of every other viewer. */
	purgeForLoad(viewerId: string): void {
		const s = this.store();
		if (s === null) return;
		const own = `${CACHE_PREFIX}${viewerId}:`;
		const ownActive = `${ACTIVE_PREFIX}${viewerId}:`;
		for (const name of this.names(s)) {
			const legacy = name === LEGACY_V1 || name.startsWith(LEGACY_V2_PREFIX);
			const foreign =
				name.startsWith(CACHE_PREFIX) && !name.startsWith(own) && !name.startsWith(ownActive);
			if (legacy || foreign) this.drop(s, name);
		}
	}

	/** D26: this viewer's valid items of `scope`. An item that fails its schema is skipped. */
	readScope(viewerId: string, scope: DraftScope): CachedDraft[] {
		const s = this.store();
		if (s === null) return [];
		const prefix = `${CACHE_PREFIX}${viewerId}:${scopeId(scope)}:`;
		const out: CachedDraft[] = [];
		for (const name of this.names(s)) {
			if (!name.startsWith(prefix)) continue;
			const conversationId = name.slice(prefix.length);
			if (conversationId === "" || conversationId.includes(":")) continue;
			let raw: unknown;
			try {
				raw = JSON.parse(s.getItem(name) ?? "");
			} catch {
				continue;
			}
			const parsed = itemSchema.safeParse(raw);
			if (!parsed.success) continue;
			out.push({ key: { ...scope, conversationId }, ...parsed.data });
		}
		return out;
	}

	/** Mirrors `activeKey` (scope id → conversation id) for this tab; it holds no words. */
	writeActive(viewerId: string, activeKey: Record<string, string>): void {
		const s = this.store();
		if (s === null) return;
		const prefix = `${ACTIVE_PREFIX}${viewerId}:`;
		for (const name of this.names(s))
			if (name.startsWith(prefix) && activeKey[name.slice(prefix.length)] === undefined)
				this.drop(s, name);
		try {
			for (const [sid, conversationId] of Object.entries(activeKey))
				s.setItem(`${prefix}${sid}`, conversationId);
		} catch {
			// the mirror is a convenience; the server rows still hold every draft
		}
	}

	/** The active conversation this tab last showed in `scope`, or null. */
	readActive(viewerId: string, scope: DraftScope): string | null {
		const s = this.store();
		if (s === null) return null;
		try {
			return s.getItem(`${ACTIVE_PREFIX}${viewerId}:${scopeId(scope)}`);
		} catch {
			return null;
		}
	}
}
