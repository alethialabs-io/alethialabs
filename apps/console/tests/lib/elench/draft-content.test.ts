// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 §4.1 and R7: the draft content schema, its normalization, the span rules and the
// distinct-mention cap, and the bound on what a maximal draft costs on the wire.
//
// The property tests use a seeded generator loop rather than fast-check, which is not a
// dependency of the console: a failure names its seed, and the same seed replays it.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mentionsSchema } from "@/lib/ai/mentions";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";
import {
	contentSchema,
	type DraftContent,
	type DraftMention,
	distinctMentions,
	isNormalizedDraftText,
	MAX_DRAFT_ARTIFACTS,
	MAX_DRAFT_DISTINCT_MENTIONS,
	MAX_DRAFT_MENTION_FIELD,
	MAX_DRAFT_MENTION_SPANS,
	normalizeDraftText,
	spansAreValid,
} from "@/lib/elench/draft-content";

/** A deterministic PRNG (mulberry32): the same seed gives the same sequence. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The code units the normalization cares about, plus ordinary ones around them. */
const UNITS = ["a", "@", " ", "\n", "\r", "\t", "\u0000", "\u0001", "\uD83D", "\uDE00", "中"];

/** A random string of up to 24 units drawn from {@link UNITS}, lone surrogates included. */
function randomRawText(next: () => number): string {
	let out = "";
	const length = Math.floor(next() * 24);
	for (let i = 0; i < length; i++) out += UNITS[Math.floor(next() * UNITS.length)];
	return out;
}

const UUID = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";

/** A mention span of `label` at `start`, of a project with `id`. */
function span(id: string, label: string, start: number): DraftMention {
	return { id, type: "project", label, start, end: start + label.length + 1 };
}

/** A valid content around `text` and `mentions`, with no artifacts and no cell target. */
function content(text: string, mentions: DraftMention[] = []): DraftContent {
	return { text, mentions, artifacts: [], cellTarget: null };
}

describe("normalizeDraftText / isNormalizedDraftText", () => {
	it("removes U+0000 and replaces lone surrogates, and nothing else", () => {
		expect(normalizeDraftText("a\u0000b")).toBe("ab");
		expect(normalizeDraftText("x\uD83Dy")).toBe("x\uFFFDy");
		expect(normalizeDraftText("x\uDE00")).toBe("x\uFFFD");
		// Kept as typed: a pair, CR and CRLF, tabs, control characters other than NUL, and the
		// surrounding whitespace (the draft is untrimmed).
		const kept = "  \uD83D\uDE00\r\n\r\t\u0001 中 ";
		expect(normalizeDraftText(kept)).toBe(kept);
		expect(isNormalizedDraftText(kept)).toBe(true);
		expect(isNormalizedDraftText("a\u0000")).toBe(false);
		expect(isNormalizedDraftText("\uD83D")).toBe(false);
		expect(isNormalizedDraftText("\uDE00a")).toBe(false);
	});

	it("is idempotent, and a text is normalized exactly when normalizing leaves it unchanged (seeded, 2,000 cases)", () => {
		for (let seed = 1; seed <= 2_000; seed++) {
			const raw = randomRawText(rng(seed));
			const once = normalizeDraftText(raw);
			expect(isNormalizedDraftText(once), `seed ${seed}`).toBe(true);
			expect(normalizeDraftText(once), `seed ${seed}`).toBe(once);
			expect(isNormalizedDraftText(raw), `seed ${seed}`).toBe(once === raw);
			expect(once.includes("\u0000"), `seed ${seed}`).toBe(false);
			expect(once.isWellFormed(), `seed ${seed}`).toBe(true);
		}
	});
});

describe("contentSchema: the text", () => {
	it("accepts exactly MAX_USER_MESSAGE_CHARS units, untrimmed, and refuses one more", () => {
		const max = " ".repeat(MAX_USER_MESSAGE_CHARS);
		expect(contentSchema.safeParse(content(max)).success).toBe(true);
		expect(contentSchema.safeParse(content(`${max} `)).success).toBe(false);
	});

	it("refuses text that is not normalized", () => {
		expect(contentSchema.safeParse(content("a\u0000b")).success).toBe(false);
		expect(contentSchema.safeParse(content("a\uD83D")).success).toBe(false);
		expect(contentSchema.safeParse(content("a\r\n\uD83D\uDE00")).success).toBe(true);
	});
});

describe("contentSchema: the span rules", () => {
	const text = "ask @web about @api"; // @web at 4..8, @api at 15..19

	it("accepts sorted spans that cover exactly '@' + label, touching pills included", () => {
		expect(
			contentSchema.safeParse(content(text, [span("p1", "web", 4), span("p2", "api", 15)]))
				.success,
		).toBe(true);
		expect(
			contentSchema.safeParse(content("@a@b", [span("p1", "a", 0), span("p2", "b", 2)])).success,
		).toBe(true);
	});

	it("refuses unsorted spans", () => {
		expect(
			contentSchema.safeParse(content(text, [span("p2", "api", 15), span("p1", "web", 4)]))
				.success,
		).toBe(false);
	});

	it("refuses overlapping spans", () => {
		// "@a@b" is one pill at 0..4, and a second span starts inside it at 2.
		const overlapping = content("@a@b", [span("p1", "a@b", 0), span("p2", "b", 2)]);
		expect(contentSchema.safeParse(overlapping).success).toBe(false);
	});

	it("refuses a span past the end of the text", () => {
		expect(contentSchema.safeParse(content("ask @we", [span("p1", "web", 4)])).success).toBe(false);
		// `slice` clamps at the end of the text, so the label check alone would pass this one.
		expect(
			contentSchema.safeParse(
				content("@web", [{ id: "p1", type: "project", label: "web", start: 0, end: 10 }]),
			).success,
		).toBe(false);
	});

	it("refuses a span that does not cover '@' + its label", () => {
		expect(contentSchema.safeParse(content(text, [span("p1", "wex", 4)])).success).toBe(false);
		expect(
			contentSchema.safeParse(
				content(text, [{ id: "p1", type: "project", label: "web", start: 5, end: 9 }]),
			).success,
		).toBe(false);
		// The right label, but an `end` that does not match it.
		expect(
			contentSchema.safeParse(
				content(text, [{ id: "p1", type: "project", label: "web", start: 4, end: 9 }]),
			).success,
		).toBe(false);
	});

	it("spansAreValid alone agrees on each rule", () => {
		expect(spansAreValid(content(text, [span("p1", "web", 4), span("p2", "api", 15)]))).toBe(
			true,
		);
		expect(spansAreValid(content(text, [span("p2", "api", 15), span("p1", "web", 4)]))).toBe(
			false,
		);
		expect(spansAreValid(content("@a@b", [span("p1", "a@b", 0), span("p2", "b", 2)]))).toBe(
			false,
		);
		expect(spansAreValid(content("ask @we", [span("p1", "web", 4)]))).toBe(false);
	});
});

describe("contentSchema: the mention fields", () => {
	it("caps id and label at 256 units, refuses an empty label and an unknown type", () => {
		const at = (id: string, label: string) => content(`@${label}`, [span(id, label, 0)]);
		const long = "x".repeat(MAX_DRAFT_MENTION_FIELD);
		expect(contentSchema.safeParse(at(long, long)).success).toBe(true);
		expect(contentSchema.safeParse(at(`${long}x`, "a")).success).toBe(false);
		expect(contentSchema.safeParse(at("p1", `${long}x`)).success).toBe(false);
		expect(
			contentSchema.safeParse(
				content("@", [{ id: "p1", type: "project", label: "", start: 0, end: 1 }]),
			).success,
		).toBe(false);
		expect(
			contentSchema.safeParse({
				...content("@a"),
				mentions: [{ id: "p1", type: "nope", label: "a", start: 0, end: 2 }],
			}).success,
		).toBe(false);
	});

	it("refuses an id or label Postgres would refuse (U+0000, a lone surrogate)", () => {
		expect(contentSchema.safeParse(content("@a", [span("p\u0000", "a", 0)])).success).toBe(false);
		expect(contentSchema.safeParse(content("@a\uD83D", [span("p1", "a\uD83D", 0)])).success).toBe(
			false,
		);
	});
});

describe("contentSchema: the mention caps", () => {
	/** `count` pills, cycling over `distinct` different ids. */
	function pills(count: number, distinct: number): DraftContent {
		let text = "";
		const mentions: DraftMention[] = [];
		for (let i = 0; i < count; i++) {
			mentions.push(span(`p${i % distinct}`, `n${i % distinct}`, text.length));
			text += `@n${i % distinct} `;
		}
		return content(text, mentions);
	}

	it("accepts 50 spans of 20 distinct mentions, and refuses a 51st span", () => {
		expect(contentSchema.safeParse(pills(MAX_DRAFT_MENTION_SPANS, 20)).success).toBe(true);
		expect(contentSchema.safeParse(pills(MAX_DRAFT_MENTION_SPANS + 1, 20)).success).toBe(false);
	});

	it("refuses a 21st DISTINCT mention even with few spans", () => {
		expect(contentSchema.safeParse(pills(MAX_DRAFT_DISTINCT_MENTIONS, 20)).success).toBe(true);
		expect(
			contentSchema.safeParse(
				pills(MAX_DRAFT_DISTINCT_MENTIONS + 1, MAX_DRAFT_DISTINCT_MENTIONS + 1),
			).success,
		).toBe(false);
	});

	it("counts distinct by type AND id: the same id under another type is another mention", () => {
		const spans: DraftMention[] = [];
		let text = "";
		for (let i = 0; i < MAX_DRAFT_DISTINCT_MENTIONS; i++) {
			spans.push(span(`p${i}`, "x", text.length));
			text += "@x";
		}
		spans.push({ id: "p0", type: "cluster", label: "x", start: text.length, end: text.length + 2 });
		text += "@x";
		expect(contentSchema.safeParse(content(text, spans)).success).toBe(false);
	});

	it("the distinct cap is the routes' cap: mentionsSchema takes 20 and refuses 21", () => {
		const list = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: "project", label: `n${i}` }));
		expect(mentionsSchema.safeParse(list(MAX_DRAFT_DISTINCT_MENTIONS)).success).toBe(true);
		expect(mentionsSchema.safeParse(list(MAX_DRAFT_DISTINCT_MENTIONS + 1)).success).toBe(false);
	});

	it("distinctMentions dedupes by type and id, in first-seen order with the first label", () => {
		const spans: DraftMention[] = [
			span("p1", "web", 0),
			{ id: "p1", type: "cluster", label: "web", start: 5, end: 9 },
			span("p1", "web-renamed", 10),
			span("p2", "api", 30),
		];
		expect(distinctMentions(spans)).toEqual([
			{ id: "p1", type: "project", label: "web" },
			{ id: "p1", type: "cluster", label: "web" },
			{ id: "p2", type: "project", label: "api" },
		]);
	});
});

describe("contentSchema: artifacts and the cell target", () => {
	it("takes up to 10 uuid artifacts and refuses an 11th or a non-uuid", () => {
		const ten = Array.from({ length: MAX_DRAFT_ARTIFACTS }, () => UUID);
		expect(contentSchema.safeParse({ ...content(""), artifacts: ten }).success).toBe(true);
		expect(contentSchema.safeParse({ ...content(""), artifacts: [...ten, UUID] }).success).toBe(
			false,
		);
		expect(contentSchema.safeParse({ ...content(""), artifacts: ["not-a-uuid"] }).success).toBe(
			false,
		);
	});

	it("takes a null cell or the routes' cell shape, and requires the field", () => {
		const cell = (cellTarget: unknown) => ({ ...content(""), cellTarget });
		expect(contentSchema.safeParse(cell(null)).success).toBe(true);
		expect(contentSchema.safeParse(cell({ x: 4, y: 12 })).success).toBe(true);
		expect(contentSchema.safeParse(cell({ x: 5, y: 0 })).success).toBe(false);
		expect(contentSchema.safeParse(cell({ x: 0, y: -1 })).success).toBe(false);
		expect(contentSchema.safeParse(cell({ x: 1.5, y: 0 })).success).toBe(false);
		const { cellTarget: _omitted, ...withoutCell } = content("");
		expect(contentSchema.safeParse(withoutCell).success).toBe(false);
	});
});

// ── R7: the worst case on the wire ──────────────────────────────────────────────────────────────

/** React's client half of a server action call: what serializes the arguments. */
interface ReplyEncoder {
	encodeReply: (value: unknown) => Promise<unknown>;
}

/** Narrows a loaded module to one exporting `encodeReply`. */
function isReplyEncoder(mod: unknown): mod is ReplyEncoder {
	return (
		typeof mod === "object" &&
		mod !== null &&
		"encodeReply" in mod &&
		typeof mod.encodeReply === "function"
	);
}

/**
 * The worst case §4.1 admits, built from the caps themselves so that raising one re-measures it:
 * every text unit U+0001 (six bytes once JSON-escaped) around 50 pills whose ids and labels are
 * 256 units of U+0001, ten artifacts and a cell target.
 */
function worstCaseContent(): DraftContent {
	const filler = "\u0001";
	const label = filler.repeat(MAX_DRAFT_MENTION_FIELD);
	const id = filler.repeat(MAX_DRAFT_MENTION_FIELD);
	const pill = `@${label}`;
	const pills = pill.repeat(MAX_DRAFT_MENTION_SPANS);
	const text = pills + filler.repeat(MAX_USER_MESSAGE_CHARS - pills.length);
	const mentions = Array.from({ length: MAX_DRAFT_MENTION_SPANS }, (_, i) =>
		span(id, label, i * pill.length),
	);
	return {
		text,
		mentions,
		artifacts: Array.from({ length: MAX_DRAFT_ARTIFACTS }, () => UUID),
		cellTarget: { x: 4, y: Number.MAX_SAFE_INTEGER },
	};
}

describe("R7: the worst-case action argument", () => {
	it("the worst-case action argument, control-character ids and labels included, encodes under 1 MiB", async () => {
		const worst = worstCaseContent();
		// The fixture is the worst case only if the schema admits it.
		expect(contentSchema.safeParse(worst).success).toBe(true);
		expect(worst.text.length).toBe(MAX_USER_MESSAGE_CHARS);

		// `claimDraft`'s argument, the largest any draft action takes (§4.2): key, base revision,
		// content, turn id, token, kind, tab id.
		const argument = {
			key: { orgId: UUID, projectId: UUID, conversationId: UUID },
			baseRevision: Number.MAX_SAFE_INTEGER,
			content: worst,
			turnId: UUID,
			token: UUID,
			kind: "first",
			tabId: UUID,
		};
		// Next 16 builds with Turbopack, so its client calls an action through this encoder.
		const require = createRequire(import.meta.url);
		const client: unknown = require(
			"next/dist/compiled/react-server-dom-turbopack/client.browser.js",
		);
		if (!isReplyEncoder(client)) throw new Error("encodeReply is not exported");
		const body = await client.encodeReply([argument]);
		if (typeof body !== "string") throw new Error("a plain argument must encode as a string");
		const bytes = new TextEncoder().encode(body).byteLength;

		expect(bytes).toBeLessThan(1024 * 1024);
		// And it IS the pathological case, not a smaller one that passes for the wrong reason:
		// six bytes per U+0001 puts it above 600 kB (ADR 0001 §4.1 measured 757,235 B).
		expect(bytes).toBeGreaterThan(700_000);
	});
});
