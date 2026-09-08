// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas draft is seeded from the server design and must be seeded AGAIN only when that design
// actually changed. A server component re-renders on every revalidate, sibling mutation and env
// poll, and each render hands the workbench a NEW object of the SAME design — object identity is
// not a change signal. `designRevision` turns the design into a content hash the store compares
// instead. It runs in a server action and in the browser, so it uses no `node:crypto`; and it is a
// change detector, not a security primitive, so a 32-bit FNV-1a over a canonical JSON is enough.

import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** The draft scope of the create flow (`~/new`), which has no project yet. */
export const NEW_DRAFT_SCOPE = "new";

/** True for a plain object (not null, not an array) — the shape whose keys get sorted. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays kept in order, `undefined` members
 * dropped (so `{a: undefined}` and `{}` read the same, as `JSON.stringify` already treats them).
 * A bare `undefined` at the root or inside an array becomes `null`, mirroring `JSON.stringify`.
 */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
	}
	if (isRecord(value)) {
		const parts: string[] = [];
		for (const key of Object.keys(value).sort()) {
			const member = value[key];
			if (member === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${stableStringify(member)}`);
		}
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** FNV-1a, 32-bit, as eight lowercase hex digits. Fast, dependency-free and isomorphic. */
export function fnv1a32(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable content hash of a server design: equal for equal content whatever the key order or
 * object identity, different for different content. The workbench seeds the store under it and
 * the store re-seeds only when it moves.
 */
export function designRevision(formData: ProjectFormData): string {
	return fnv1a32(stableStringify(formData));
}

/**
 * The persisted-draft scope a canvas belongs to: `"new"` for the create flow (no project yet),
 * otherwise `<projectId>:<environmentId>`, with `"default"` standing in for an environment the
 * page could not resolve. One sessionStorage slot per scope, so switching environments never
 * shows the previous one's unsaved edits.
 */
export function draftScope(
	projectId: string | undefined,
	environmentId: string | undefined,
): string {
	if (!projectId) return NEW_DRAFT_SCOPE;
	return `${projectId}:${environmentId ?? "default"}`;
}
