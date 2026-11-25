// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The subset of JSON Patch (RFC 6902) `apply_design_patch` accepts — `add`, `remove` and `replace`
// over JSON Pointers (RFC 6901) — applied to a copy, in order, all or none. A pointer that does not
// resolve is returned as a design error with the operation's index, never thrown.

import type { z } from "zod";

/** A JSON value. */
type Json = z.output<ReturnType<typeof z.json>>;

/** One patch operation. */
export interface PatchOperation {
	op: "add" | "remove" | "replace";
	path: string;
	value?: Json;
}

/** Why a patch could not be applied, in the design-error shape the tools return. */
interface PatchProblem {
	path: string;
	code: string;
	message: string;
	fix: string | null;
}

/** The patched document, or the first operation that could not be applied. */
export type PatchResult = { ok: true; document: Json } | { ok: false; problem: PatchProblem };

/** Member names that reach an object's prototype rather than its data; never a design key. */
const FORBIDDEN_TOKENS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** True for a JSON object (not an array, not null). */
function isObject(value: Json | undefined): value is { [key: string]: Json } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The reference tokens of `pointer`, unescaped; null when it is not a JSON Pointer. */
export function parsePointer(pointer: string): string[] | null {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) return null;
	return pointer
		.slice(1)
		.split("/")
		.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** `tokens` as a JSON Pointer. */
export function formatPointer(tokens: readonly (string | number)[]): string {
	return tokens.map((t) => `/${String(t).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** An array index token: `-` (append, `add` only) or a non-negative decimal without leading zeros. */
function arrayIndex(token: string, length: number, allowEnd: boolean): number | null {
	if (token === "-") return allowEnd ? length : null;
	if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
	const index = Number(token);
	return index < length || (allowEnd && index === length) ? index : null;
}

/** Applies one operation to `doc` in place, or says why it cannot. */
function applyOne(doc: Json, operation: PatchOperation, index: number): PatchProblem | null {
	const problem = (code: string, message: string): PatchProblem => ({
		path: operation.path,
		code,
		message: `Operation ${index} (${operation.op}): ${message}`,
		fix: null,
	});
	const tokens = parsePointer(operation.path);
	if (tokens === null) return problem("invalid_pointer", "the path must be a JSON Pointer starting with /.");
	if (tokens.length === 0) return problem("invalid_pointer", "the whole design cannot be replaced; patch its members.");
	if (tokens.some((token) => FORBIDDEN_TOKENS.has(token))) {
		return problem("invalid_pointer", "the path names an object's prototype, which a design does not have.");
	}
	if (operation.op !== "remove" && operation.value === undefined) {
		return problem("missing_value", "add and replace need a value.");
	}
	let parent: Json = doc;
	for (const token of tokens.slice(0, -1)) {
		if (isObject(parent) && Object.hasOwn(parent, token)) {
			parent = parent[token];
		} else if (Array.isArray(parent)) {
			const at = arrayIndex(token, parent.length, false);
			if (at === null) return problem("path_not_found", `no element ${token} in the array.`);
			parent = parent[at];
		} else {
			return problem("path_not_found", `nothing at ${token}.`);
		}
	}
	const last = tokens[tokens.length - 1];
	const value = operation.value ?? null;
	if (Array.isArray(parent)) {
		const at = arrayIndex(last, parent.length, operation.op === "add");
		if (at === null) return problem("path_not_found", `no element ${last} in the array.`);
		if (operation.op === "add") parent.splice(at, 0, value);
		else if (operation.op === "remove") parent.splice(at, 1);
		else parent[at] = value;
		return null;
	}
	if (!isObject(parent)) return problem("path_not_found", `the parent of ${last} is not an object or array.`);
	if (operation.op !== "add" && !Object.hasOwn(parent, last)) {
		return problem("path_not_found", `nothing at ${last} to ${operation.op}.`);
	}
	if (operation.op === "remove") delete parent[last];
	else parent[last] = value;
	return null;
}

/** Applies `operations` to a copy of `document`, in order, all or none. */
export function applyJsonPatch(document: Json, operations: readonly PatchOperation[]): PatchResult {
	const copy: Json = structuredClone(document);
	for (const [index, operation] of operations.entries()) {
		const problem = applyOne(copy, operation, index);
		if (problem) return { ok: false, problem };
	}
	return { ok: true, document: copy };
}
