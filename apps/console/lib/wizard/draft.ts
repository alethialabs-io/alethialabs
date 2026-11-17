// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a wizard's draft is kept, and the one function that decides what goes into it.
//
// WHAT IS WRITTEN. `draftValues` is the only producer of a stored value. It copies, out of the
// form, the keys the draft schema names — nothing else is even read — and then parses that copy
// with the schema. So a field reaches storage only if a definition lists it, and only as the
// plain value the schema parses it to. The same function runs again on the way back in, so what
// is restored into a form is held to the same list as what was written. A draft schema that is
// not an allowlist (see `define.ts`) produces nothing at all, in both directions.
//
// WHERE. `sessionStorage`, under `alethia:wizard:v<version>:<id>:<viewer>:<scope>`. That storage
// survives a refresh, Back, closing a sheet and a same-tab redirect, and it ends with the tab.
// The key carries the viewer, and reading a draft also removes every draft another viewer left
// in this tab, so signing in as someone else never shows the previous person's answers.
// `clearAllWizardDrafts` is the explicit form of that for a sign-out handler.
//
// WHEN IT GOES AWAY. On completion, on "Start over", on sign-out, when the definition's version
// moves, when the stored text does not parse, and when it is older than the definition's TTL.
//
// Storage that throws (a browser that refuses it) falls back to a map held by this page, so the
// wizard still survives closing and reopening a sheet; a reload then starts clean.

import { z } from "zod";
import { isViewId } from "@/lib/query/view-url-params";
import { draftSchemaProblems, draftTopLevelKeys } from "@/lib/wizard/define";
import type { WizardDraft } from "@/lib/wizard/types";

/** Every draft key starts with this. */
const KEY_PREFIX = "alethia:wizard:";

/** What a draft belongs to: one wizard, one viewer, one scope. */
export interface DraftAddress {
	readonly id: string;
	readonly viewerId: string;
	readonly scope: string;
}

/** A draft read back from storage. */
export interface StoredDraft {
	readonly values: Record<string, unknown>;
	/** The step that was on screen when the draft was last written. */
	readonly step: string;
}

/** The stored text's shape. `values` is re-read through the draft schema, never trusted as stored. */
const envelopeSchema = z.object({
	v: z.number(),
	step: z.string(),
	at: z.number(),
	values: z.unknown(),
});

/** Drafts kept by this page only, for a browser whose storage throws. */
const memoryFallback = new Map<string, string>();

/** Whether `value` is a plain object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tab's storage, or `null` where there is none or reaching it throws. */
function tabStorage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.sessionStorage;
	} catch {
		return null;
	}
}

/** The storage key of one draft. */
export function draftKey(address: DraftAddress, version: number): string {
	const parts = [address.id, address.viewerId, address.scope].map(encodeURIComponent);
	return `${KEY_PREFIX}v${version}:${parts.join(":")}`;
}

/** The parts of a draft key, or `null` when `key` is not one. */
function parseDraftKey(key: string): { version: string; id: string; viewer: string; scope: string } | null {
	if (!key.startsWith(KEY_PREFIX)) return null;
	const [version, id, viewer, scope, ...rest] = key.slice(KEY_PREFIX.length).split(":");
	if (version === undefined || id === undefined || viewer === undefined || scope === undefined) return null;
	if (rest.length > 0) return null;
	return { version, id, viewer, scope };
}

/** Every key in the tab's storage and in the page fallback. */
function allKeys(): string[] {
	const keys = new Set<string>(memoryFallback.keys());
	const storage = tabStorage();
	try {
		for (let index = 0; storage !== null && index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key !== null) keys.add(key);
		}
	} catch {
		// Storage that throws holds nothing this page can list; the fallback keys still count.
	}
	return [...keys];
}

/** Removes one key from the tab's storage and from the page fallback. */
function removeKey(key: string): void {
	memoryFallback.delete(key);
	try {
		tabStorage()?.removeItem(key);
	} catch {
		// Nothing to remove from storage that throws.
	}
}

/**
 * What a draft may hold of `values`: the keys the draft schema names, parsed by it. `null` when
 * the schema is not an allowlist, when `values` is not an object, or when the parse fails — in
 * each case nothing is written and nothing is restored.
 */
export function draftValues(draft: WizardDraft, values: unknown): Record<string, unknown> | null {
	if (draftSchemaProblems(draft.schema).length > 0) return null;
	const keys = draftTopLevelKeys(draft.schema);
	if (keys === null || !isRecord(values)) return null;
	const listed = Object.fromEntries(
		keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]),
	);
	const parsed = draft.schema.safeParse(listed);
	if (!parsed.success || !isRecord(parsed.data)) return null;
	return parsed.data;
}

/**
 * Writes the draft. Returns false when nothing could be written because the values do not pass
 * the draft schema; the draft already stored, if any, is left as it is.
 */
export function writeDraft(
	address: DraftAddress,
	draft: WizardDraft,
	values: unknown,
	step: string,
	now: number,
): boolean {
	const kept = draftValues(draft, values);
	if (kept === null) return false;
	const key = draftKey(address, draft.version);
	const text = JSON.stringify({ v: draft.version, step, at: now, values: kept });
	const storage = tabStorage();
	try {
		if (storage === null) throw new Error("no tab storage");
		storage.setItem(key, text);
		memoryFallback.delete(key);
	} catch {
		memoryFallback.set(key, text);
	}
	return true;
}

/** The stored text of one draft, from the tab's storage or, failing that, the page fallback. */
function readText(key: string): string | null {
	try {
		const stored = tabStorage()?.getItem(key);
		if (typeof stored === "string") return stored;
	} catch {
		// Fall through to the page fallback.
	}
	return memoryFallback.get(key) ?? null;
}

/** The stored text as an envelope, or `null` when it is not one. */
function parseEnvelope(text: string): z.infer<typeof envelopeSchema> | null {
	try {
		const json: unknown = JSON.parse(text);
		const parsed = envelopeSchema.safeParse(json);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Reads the draft at `address`. A draft that does not parse, is of another version, is older than
 * the TTL, is dated in the future, or no longer passes the draft schema is removed and `null` is
 * returned. Also removes drafts left in this tab by another viewer or another version (`sweepDrafts`).
 */
export function readDraft(address: DraftAddress, draft: WizardDraft, now: number): StoredDraft | null {
	sweepDrafts(address, draft.version);
	const key = draftKey(address, draft.version);
	const text = readText(key);
	if (text === null) return null;
	const envelope = parseEnvelope(text);
	const fresh =
		envelope !== null &&
		envelope.v === draft.version &&
		envelope.at <= now &&
		now - envelope.at <= draft.ttlMinutes * 60_000 &&
		isViewId(envelope.step);
	const values = fresh ? draftValues(draft, envelope.values) : null;
	if (envelope === null || values === null) {
		removeKey(key);
		return null;
	}
	return { values, step: envelope.step };
}

/** Removes the draft at `address`, whatever its version. */
export function clearDraft(address: DraftAddress): void {
	const id = encodeURIComponent(address.id);
	const viewer = encodeURIComponent(address.viewerId);
	const scope = encodeURIComponent(address.scope);
	for (const key of allKeys()) {
		const parts = parseDraftKey(key);
		if (parts !== null && parts.id === id && parts.viewer === viewer && parts.scope === scope) {
			removeKey(key);
		}
	}
}

/**
 * Removes the drafts that can no longer be this viewer's to restore: every draft of another
 * viewer, and the draft at `address` in any version but `version`.
 */
export function sweepDrafts(address: DraftAddress, version: number): void {
	const id = encodeURIComponent(address.id);
	const viewer = encodeURIComponent(address.viewerId);
	const scope = encodeURIComponent(address.scope);
	for (const key of allKeys()) {
		const parts = parseDraftKey(key);
		if (parts === null) continue;
		const foreign = parts.viewer !== viewer;
		const outdated = parts.id === id && parts.scope === scope && parts.version !== `v${version}`;
		if (foreign || outdated) removeKey(key);
	}
}

/** Removes every wizard draft in this tab. For a sign-out handler. */
export function clearAllWizardDrafts(): void {
	for (const key of allKeys()) {
		if (key.startsWith(KEY_PREFIX)) removeKey(key);
	}
}

/**
 * `base` with a restored draft laid over it. Plain objects merge key by key, so a draft that
 * keeps part of a nested object does not erase the rest; anything else is replaced.
 */
export function mergeDraftInto(
	base: Record<string, unknown>,
	draft: Record<string, unknown>,
): Record<string, unknown> {
	const merged = new Map<string, unknown>(Object.entries(base));
	for (const [key, value] of Object.entries(draft)) {
		const existing = merged.get(key);
		merged.set(key, isRecord(existing) && isRecord(value) ? mergeDraftInto(existing, value) : value);
	}
	return Object.fromEntries(merged);
}
