// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE console list paging contract — the one keyset cursor codec every `query<Thing>Page` builder
// pages through (lib/query/README.md → "Paging"; epic #7481, LST-0 #7482).
//
// Lifted from the support cases list (`lib/queries/support.ts`, #7389), which had already solved
// the one subtle part: Postgres keeps microseconds, a cursor travels through a JS `Date` that keeps
// milliseconds, so ordering and comparing on the RAW column lets a row in the cursor's millisecond
// but a later microsecond fall on the wrong side of the boundary — skipped. The fix is to order
// and compare on the SAME expression, the sort key truncated to milliseconds ({@link keysetSortKey}),
// so the two cannot disagree. Everything here exists to make that the only way to write a page.
//
// WHAT A CURSOR IS. An opaque string over `(sortKey truncated to ms, id)`. Opaque on purpose: a
// client that can read a cursor will start building one, and then the server can never change
// what it carries. It is versioned (`v1`), so a later shape can refuse old cursors rather than
// misread them. A malformed cursor is a 400 (the input schema refuses it), never "page one": a
// silent restart re-shows rows the reader has already seen and looks exactly like a working list.
//
// WHY NOT `lib/cli/paging.ts`. That is the CLI's server vocabulary: a microsecond text key, a
// cursor bound to a scope hash, and a capped total. The console standard draws the other line on
// all three — ms truncation (the support list's proof), no scope in the cursor (the scope is the
// transaction's RLS / predicate, re-applied on every page), and NO total at all (counts live only
// in facet options, lib/query/README.md → "Counts"). Two vocabularies for two clients; neither
// imports the other.
//
// No `import "server-only"`: the codec, the schemas and the in-memory pager are pure, and the
// client reads the page TYPES from here (`lib/query/use-keyset-list.ts`).

import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

/** Rows a page carries when the caller names no `limit`. */
export const KEYSET_DEFAULT_LIMIT = 50;

/** The largest `limit` a page request may ask for. A larger one is refused by the schema, not clamped. */
export const KEYSET_MAX_LIMIT = 100;

/** Cursor envelope version. Changing the tuple bumps it, which invalidates every cursor in flight. */
const CURSOR_VERSION = "v1";

/** Longest cursor string accepted before decoding — a bound on work, far above any real cursor. */
const CURSOR_MAX_LENGTH = 512;

/** `2026-11-20T10:00:00.123Z`: exactly what `Date.prototype.toISOString` renders, ms precision. */
const MS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_ID = /^(0|[1-9]\d{0,18})$/;

/**
 * What a list's id column holds, which decides how a cursor's id is validated and cast. A cursor
 * whose id is not of the column's kind would reach Postgres and raise — a 500 for what is a bad
 * request — so the kind is checked at decode time, and the cast is chosen from this closed set.
 */
export type KeysetIdKind = "uuid" | "integer" | "text";

/** A decoded keyset position: the last row of the previous page, by the list's own sort key. */
export interface KeysetPosition {
	/** The row's sort key as a ms-precision ISO instant (`toISOString()`), already truncated. */
	at: string;
	/** The row's id — the tiebreaker that makes the order total. */
	id: string;
}

/** A position as a builder knows it about a row: the raw sort instant (any precision) and the id. */
export interface KeysetKey {
	at: Date | string;
	id: string | number;
}

/**
 * The page a `query<Thing>Page` builder returns — THE shape of every console list read.
 *
 * - `rows`: at most `limit` rows, strictly after the request's cursor, in the list's total order.
 * - `nextCursor`: the cursor for the page after this one, or `null` when this page is the last.
 *   Exact, not a guess: the builder reads `limit + 1` rows ({@link keysetFetchLimit}), so a page
 *   of exactly `limit` rows at the end of the list says `null` instead of costing an empty read.
 * - `facets`: the facet pass over the UNFILTERED universe, on the first page only (`null` after),
 *   because a later page walks the same universe and would compute identical counts.
 * - `universeEmpty`: on the first page only — `true` when the scope holds nothing at all (the
 *   first-run empty state with its create action), `false` when it holds something (an empty
 *   `rows` is then the FILTERED empty state). A boolean, never a count (README → "Counts").
 */
export interface KeysetListPage<Row, Facets = null> {
	rows: Row[];
	nextCursor: string | null;
	facets: Facets | null;
	universeEmpty: boolean | null;
}

/** One page request, as the input schema delivers it: a decoded cursor (absent on page one) and a limit. */
export interface KeysetPageRequest {
	cursor?: KeysetPosition;
	limit: number;
}

// ── the codec ───────────────────────────────────────────────────────────────────────────────

/** Truncates an instant to the millisecond and renders it the way the cursor carries it. */
function msIso(at: Date | string): string {
	const date = at instanceof Date ? at : new Date(at);
	if (Number.isNaN(date.getTime())) throw new RangeError(`keyset: not an instant: ${String(at)}`);
	return date.toISOString();
}

/** base64url of a UTF-8 string — `btoa` is Latin-1 only, so the bytes are encoded first. */
function toBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The inverse of {@link toBase64Url}, or null for anything that is not base64url of UTF-8. */
function fromBase64Url(raw: string): string | null {
	if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
	try {
		const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** True when `id` is a valid id of `kind`. */
function isIdOfKind(id: string, kind: KeysetIdKind): boolean {
	if (kind === "uuid") return UUID.test(id);
	if (kind === "integer") return INTEGER_ID.test(id);
	return id.length > 0 && id.length <= 256;
}

/**
 * Encodes a row's keyset position as an opaque cursor. The instant is truncated to milliseconds
 * HERE, so a builder can hand over a microsecond-precision value and still mint a cursor that
 * agrees with the ms-truncated ORDER BY.
 */
export function encodeKeysetCursor(key: KeysetKey): string {
	return toBase64Url(JSON.stringify([CURSOR_VERSION, msIso(key.at), String(key.id)]));
}

/**
 * Decodes a cursor, or returns null when it is not one this codec minted for an id of `kind`:
 * not base64url, not JSON, the wrong version or arity, an instant that is not a real
 * millisecond (`2026-02-30…` is refused: `Date` would roll it over to March), or an id of the
 * wrong kind. Null is a REFUSAL — the input schema turns it into a 400 — never "start over".
 */
export function decodeKeysetCursor(raw: string, kind: KeysetIdKind = "uuid"): KeysetPosition | null {
	if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH) return null;
	const text = fromBase64Url(raw);
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length !== 3) return null;
	const [version, at, id] = parsed;
	if (version !== CURSOR_VERSION || typeof at !== "string" || typeof id !== "string") return null;
	if (!MS_ISO.test(at)) return null;
	const instant = new Date(at);
	if (Number.isNaN(instant.getTime()) || instant.toISOString() !== at) return null;
	if (!isIdOfKind(id, kind)) return null;
	return { at, id };
}

// ── the input schema ────────────────────────────────────────────────────────────────────────

/**
 * The cursor field of a list procedure's input: an opaque string, decoded and validated at the
 * boundary, so the handler only ever sees a {@link KeysetPosition}. A cursor that does not decode
 * fails validation, which oRPC answers as BAD_REQUEST (400).
 */
export function keysetCursorSchema(kind: KeysetIdKind = "uuid") {
	return z
		.string()
		.max(CURSOR_MAX_LENGTH)
		.transform((raw, ctx) => {
			const position = decodeKeysetCursor(raw, kind);
			if (position === null) {
				ctx.addIssue({ code: "custom", message: "Malformed list cursor." });
				return z.NEVER;
			}
			return position;
		});
}

/**
 * The paging half of a list procedure's input, to spread next to its filter fields:
 * `z.object({ ...filters, ...keysetPageInput() })`. `limit` defaults to
 * {@link KEYSET_DEFAULT_LIMIT} and is REFUSED above {@link KEYSET_MAX_LIMIT} — a clamp would let a
 * client believe it got the page size it asked for.
 */
export function keysetPageInput(kind: KeysetIdKind = "uuid") {
	return {
		cursor: keysetCursorSchema(kind).optional(),
		limit: z.number().int().min(1).max(KEYSET_MAX_LIMIT).default(KEYSET_DEFAULT_LIMIT),
	};
}

// ── the SQL half ────────────────────────────────────────────────────────────────────────────

/**
 * A list's sort key, truncated to milliseconds. Pass THIS to both {@link keysetOrderBy} and
 * {@link keysetAfter}: the order and the cursor predicate must read the same expression, or a row
 * in the cursor's millisecond lands on the wrong side of it (the support list's lesson, #7389).
 */
export function keysetSortKey(column: PgColumn | SQL): SQL {
	return sql`date_trunc('milliseconds', ${column})`;
}

/**
 * {@link keysetSortKey} in a form an index can hold, for a `timestamptz` column: the instant read as
 * UTC wall time, then truncated to milliseconds. Pair it with {@link keysetUtcAfter}, never with
 * {@link keysetAfter}.
 *
 * Why it exists: `date_trunc(text, timestamptz)` is STABLE — it reads the session TimeZone — and
 * Postgres refuses a non-IMMUTABLE function in an index expression, so no index can match
 * {@link keysetSortKey}'s expression. The `timestamp` overload is IMMUTABLE. The order is the same
 * one: `AT TIME ZONE 'UTC'` is a monotonic bijection and a millisecond boundary does not depend on
 * the offset. A list whose table is large enough to need its sort indexed uses this, and its index
 * names the identical expression (the Activity log's `idx_authz_activity_org_ts_ms_id`, #7539).
 */
export function keysetUtcSortKey(column: PgColumn): SQL {
	return sql`date_trunc('milliseconds', (${column} at time zone 'UTC'))`;
}

/** The ORDER BY of a keyset list: newest first, the id breaking ties, so the order is total. */
export function keysetOrderBy(sortKey: SQL, id: PgColumn): [SQL, SQL] {
	return [sql`${sortKey} desc`, sql`${id} desc`];
}

/** The SQL cast for a cursor id of `kind` — a closed set, never interpolated from input. */
function idCast(kind: KeysetIdKind): SQL {
	return sql.raw(kind === "uuid" ? "::uuid" : kind === "integer" ? "::bigint" : "::text");
}

/**
 * The cursor predicate: rows strictly after `cursor` in {@link keysetOrderBy}'s order, as ONE
 * row-value comparison `(sort_key, id) < (at, id)` — which Postgres evaluates lexicographically, so
 * ties on the sort key fall to the id. Undefined on page one (no cursor), so it drops out of an
 * `and(…)`.
 */
export function keysetAfter(
	sortKey: SQL,
	id: PgColumn,
	cursor: KeysetPosition | undefined,
	kind: KeysetIdKind = "uuid",
): SQL | undefined {
	if (cursor === undefined) return undefined;
	return sql`(${sortKey}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id}${idCast(kind)})`;
}

/**
 * {@link keysetAfter} for a {@link keysetUtcSortKey}: the cursor's instant is read as UTC wall time
 * too, so both sides of the comparison are `timestamp` in the same frame. Comparing that key with a
 * bare `timestamptz` would convert it through the session TimeZone and move the boundary by the
 * offset on any connection not set to UTC.
 */
export function keysetUtcAfter(
	sortKey: SQL,
	id: PgColumn,
	cursor: KeysetPosition | undefined,
	kind: KeysetIdKind = "uuid",
): SQL | undefined {
	if (cursor === undefined) return undefined;
	return sql`(${sortKey}, ${id}) < ((${cursor.at}::timestamptz at time zone 'UTC'), ${cursor.id}${idCast(kind)})`;
}

/** How many rows a builder reads for a page of `limit`: one more, which is how the end is known exactly. */
export function keysetFetchLimit(limit: number): number {
	return limit + 1;
}

// ── turning rows into a page ────────────────────────────────────────────────────────────────

/**
 * Cuts the rows a builder read (up to {@link keysetFetchLimit}`(limit)` of them, already in order)
 * into a page: the first `limit` rows, and the cursor of the last one when a further row exists.
 */
export function keysetPage<Row>(
	fetched: readonly Row[],
	limit: number,
	keyOf: (row: Row) => KeysetKey,
): { rows: Row[]; nextCursor: string | null } {
	const more = fetched.length > limit;
	const rows = more ? fetched.slice(0, limit) : [...fetched];
	const last = rows.at(-1);
	return { rows, nextCursor: more && last !== undefined ? encodeKeysetCursor(keyOf(last)) : null };
}

/** Compares two ids the way the matching Postgres column would order them. */
function compareIds(a: string, b: string, kind: KeysetIdKind): number {
	if (kind === "integer") {
		const x = BigInt(a);
		const y = BigInt(b);
		return x < y ? -1 : x > y ? 1 : 0;
	}
	// uuid ordering in Postgres is bytewise, which is lexicographic over lower-case hex.
	const x = kind === "uuid" ? a.toLowerCase() : a;
	const y = kind === "uuid" ? b.toLowerCase() : b;
	return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Pages a COMPOSED universe — one the server assembles in memory from several reads (runners,
 * clusters, environments) — through the same contract as SQL: the same order (ms-truncated sort
 * key, then id, both descending), the same strictly-after cursor, the same exact `nextCursor`.
 * The browser still receives one page; the universe never leaves the server.
 *
 * `universe` is the FILTERED rows (the facet pass is the caller's, over the unfiltered set).
 */
export function keysetPageInMemory<Row>(
	universe: readonly Row[],
	request: KeysetPageRequest,
	keyOf: (row: Row) => KeysetKey,
	kind: KeysetIdKind = "uuid",
): { rows: Row[]; nextCursor: string | null } {
	const keyed = universe.map((row) => {
		const key = keyOf(row);
		return { row, at: Date.parse(msIso(key.at)), id: String(key.id) };
	});
	keyed.sort((a, b) => b.at - a.at || compareIds(b.id, a.id, kind));
	const cursor = request.cursor;
	const cursorAt = cursor === undefined ? null : Date.parse(cursor.at);
	const after =
		cursor === undefined || cursorAt === null
			? keyed
			: keyed.filter((k) => k.at < cursorAt || (k.at === cursorAt && compareIds(k.id, cursor.id, kind) < 0));
	return keysetPage(
		after.slice(0, keysetFetchLimit(request.limit)).map((k) => k.row),
		request.limit,
		keyOf,
	);
}

/**
 * Assembles the full {@link KeysetListPage} from a cut page and, on the first page, the facet
 * pass and the universe-empty probe. `first` is null on any later page, so a builder cannot send
 * facets twice or forget to null them.
 */
export function keysetListPage<Row, Facets>(
	page: { rows: Row[]; nextCursor: string | null },
	first: { facets: Facets; universeEmpty: boolean } | null,
): KeysetListPage<Row, Facets> {
	return {
		rows: page.rows,
		nextCursor: page.nextCursor,
		facets: first?.facets ?? null,
		universeEmpty: first?.universeEmpty ?? null,
	};
}

// ── the TEXT mode: alphabetical lists (LST-8 #7490) ─────────────────────────────────────────
//
// Everything above pages by an INSTANT — newest first. Some lists are read by NAME: a person looks
// a member, a team or a role up alphabetically, and bending those lists to newest-first because the
// codec could only order by time would be the cursor deciding the product. So the codec has a
// second, additive mode over `(sort text, id)`, ascending, and nothing above changes.
//
// THE ONE SUBTLE PART, the text mode's version of the millisecond lesson: the SQL order, the cursor
// predicate and any in-memory merge must agree on what "before" means for two strings, and two
// collations rarely agree (`ORDER BY name` under a glibc or ICU locale skips punctuation at the first
// level, sorts "a" and "A" together by rules nobody here chose, and can differ between two Postgres
// hosts). So the sort text is ALWAYS `lower(expr) COLLATE "C"` — case-folded by the database, then
// compared byte by byte in UTF-8 — and the in-memory comparator ({@link compareSortText}) compares
// the same UTF-8 bytes. The text a cursor carries is the database's own `lower(…)` of the last row
// (the builder selects it), never a JS `toLowerCase()`, which folds some characters differently.
//
// WHAT A TEXT CURSOR IS. The same opaque envelope, versioned `t1` so a time cursor can never be
// misread as a text one (or the reverse), carrying the sort text itself — not a row id to read it
// back by, so a row deleted between two pages cannot end the walk. That makes a text cursor longer
// than a time cursor, so it has its own (larger) bound.
//
// INDEXES. A list that grows large wants an expression index on `(lower(col) COLLATE "C", id)` to
// serve this order; the lists on it today (members, teams, custom roles) are org-scoped and small,
// and the org predicate's index bounds the scan.

/** Text-cursor envelope version — distinct from {@link CURSOR_VERSION}, so the two modes never cross. */
const TEXT_CURSOR_VERSION = "t1";

/** The longest sort text a cursor may carry (characters) — far above any name or email. */
const SORT_TEXT_MAX_LENGTH = 2048;

/** Longest text cursor accepted before decoding: the sort text, UTF-8 and base64-inflated, plus the envelope. */
const TEXT_CURSOR_MAX_LENGTH = 12_000;

/** A decoded text keyset position: the last row of the previous page, by its sort text and id. */
export interface KeysetTextPosition {
	/** The row's sort text exactly as the database folded it (`lower(…)`). */
	text: string;
	/** The row's id — the tiebreaker that makes the order total. */
	id: string;
}

/** A text position as a builder knows it about a row: its database-folded sort text and its id. */
export interface KeysetTextKey {
	text: string;
	id: string | number;
}

/** One text-mode page request: a decoded cursor (absent on page one) and a limit. */
export interface KeysetTextPageRequest {
	cursor?: KeysetTextPosition;
	limit: number;
}

/** Encodes a row's text position as an opaque `t1` cursor. */
export function encodeKeysetTextCursor(key: KeysetTextKey): string {
	return toBase64Url(JSON.stringify([TEXT_CURSOR_VERSION, key.text, String(key.id)]));
}

/**
 * Decodes a text cursor, or returns null when it is not one this codec minted for an id of `kind`
 * — not base64url, not JSON, the wrong version (a time cursor included) or arity, a sort text over
 * the bound, or an id of the wrong kind. Null is a REFUSAL (a 400), never "start over".
 */
export function decodeKeysetTextCursor(raw: string, kind: KeysetIdKind = "uuid"): KeysetTextPosition | null {
	if (raw.length === 0 || raw.length > TEXT_CURSOR_MAX_LENGTH) return null;
	const json = fromBase64Url(raw);
	if (json === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length !== 3) return null;
	const [version, text, id] = parsed;
	if (version !== TEXT_CURSOR_VERSION || typeof text !== "string" || typeof id !== "string") return null;
	if (text.length > SORT_TEXT_MAX_LENGTH) return null;
	if (!isIdOfKind(id, kind)) return null;
	return { text, id };
}

/** The cursor field of a text-mode list input: decoded at the boundary, a malformed one a 400. */
export function keysetTextCursorSchema(kind: KeysetIdKind = "uuid") {
	return z
		.string()
		.max(TEXT_CURSOR_MAX_LENGTH)
		.transform((raw, ctx) => {
			const position = decodeKeysetTextCursor(raw, kind);
			if (position === null) {
				ctx.addIssue({ code: "custom", message: "Malformed list cursor." });
				return z.NEVER;
			}
			return position;
		});
}

/** The paging half of a text-mode list input — {@link keysetPageInput}'s twin, same `limit` rules. */
export function keysetTextPageInput(kind: KeysetIdKind = "uuid") {
	return {
		cursor: keysetTextCursorSchema(kind).optional(),
		limit: z.number().int().min(1).max(KEYSET_MAX_LIMIT).default(KEYSET_DEFAULT_LIMIT),
	};
}

/**
 * A list's sort text: `lower(expr) COLLATE "C"`. Pass THIS to {@link keysetTextOrderBy} and
 * {@link keysetTextAfter}, and SELECT it so the builder can mint the cursor from the database's own
 * folding — the order, the predicate and the cursor then read one expression.
 */
export function keysetTextSortKey(expr: PgColumn | SQL): SQL {
	return sql`lower(${expr}) collate "C"`;
}

/** The ORDER BY of a text keyset list: alphabetical, the id breaking ties, so the order is total. */
export function keysetTextOrderBy(sortKey: SQL, id: PgColumn): [SQL, SQL] {
	return [sql`${sortKey} asc`, sql`${id} asc`];
}

/**
 * The text cursor predicate: rows strictly after `cursor`, as ONE row-value comparison
 * `(sort_text, id) > (text COLLATE "C", id)`. Undefined on page one, so it drops out of an `and(…)`.
 */
export function keysetTextAfter(
	sortKey: SQL,
	id: PgColumn,
	cursor: KeysetTextPosition | undefined,
	kind: KeysetIdKind = "uuid",
): SQL | undefined {
	if (cursor === undefined) return undefined;
	return sql`(${sortKey}, ${id}) > (${cursor.text}::text collate "C", ${cursor.id}${idCast(kind)})`;
}

/** The UTF-8 bytes of a string — what `COLLATE "C"` compares in a UTF-8 database. */
function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/**
 * Compares two sort texts exactly as `COLLATE "C"` does in a UTF-8 database: byte by byte. NOT
 * `a < b` — JavaScript compares UTF-16 code units, which orders characters above U+FFFF before
 * U+E000–U+FFFF, the opposite of their UTF-8 bytes.
 */
export function compareSortText(a: string, b: string): number {
	if (a === b) return 0;
	const x = utf8(a);
	const y = utf8(b);
	const n = Math.min(x.length, y.length);
	for (let i = 0; i < n; i += 1) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/**
 * Cuts the rows a text-mode builder read (up to `limit + 1`, already in order) into a page — the
 * first `limit` rows, and the text cursor of the last one when a further row exists.
 */
export function keysetTextPage<Row>(
	fetched: readonly Row[],
	limit: number,
	keyOf: (row: Row) => KeysetTextKey,
): { rows: Row[]; nextCursor: string | null } {
	const more = fetched.length > limit;
	const rows = more ? fetched.slice(0, limit) : [...fetched];
	const last = rows.at(-1);
	return { rows, nextCursor: more && last !== undefined ? encodeKeysetTextCursor(keyOf(last)) : null };
}

/**
 * Pages a composed universe through the text mode, in the SQL order: sort text by
 * {@link compareSortText}, then id, ascending, strictly after the cursor, with the exact next
 * cursor. `keyOf` must hand back the DATABASE-folded text the rows were selected with.
 */
export function keysetTextPageInMemory<Row>(
	universe: readonly Row[],
	request: KeysetTextPageRequest,
	keyOf: (row: Row) => KeysetTextKey,
	kind: KeysetIdKind = "uuid",
): { rows: Row[]; nextCursor: string | null } {
	const keyed = universe.map((row) => {
		const key = keyOf(row);
		return { row, text: key.text, id: String(key.id) };
	});
	keyed.sort((a, b) => compareSortText(a.text, b.text) || compareIds(a.id, b.id, kind));
	const cursor = request.cursor;
	const after =
		cursor === undefined
			? keyed
			: keyed.filter((k) => {
					const byText = compareSortText(k.text, cursor.text);
					return byText > 0 || (byText === 0 && compareIds(k.id, cursor.id, kind) > 0);
				});
	return keysetTextPage(
		after.slice(0, keysetFetchLimit(request.limit)).map((k) => k.row),
		request.limit,
		keyOf,
	);
}
