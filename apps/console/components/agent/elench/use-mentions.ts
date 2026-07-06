"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useState } from "react";
import { searchMentions } from "@/app/server/actions/mentions";
import type { MentionResult } from "@/lib/ai/mentions";

/** An active `@…` token in the composer: where it starts and the typed query. */
export interface MentionAnchor {
	/** Index of the `@` in the textarea value. */
	start: number;
	/** The text typed after the `@` (may be ""). */
	query: string;
}

/**
 * Detect an in-progress `@mention` at the caret. A mention token is an `@` at the
 * start of the value or after whitespace, followed by non-whitespace up to the caret.
 * Returns null when the caret is not inside such a token.
 */
export function detectMention(
	value: string,
	caret: number,
): MentionAnchor | null {
	const upto = value.slice(0, caret);
	const at = upto.lastIndexOf("@");
	if (at === -1) return null;
	const before = at === 0 ? " " : upto[at - 1];
	if (!/\s/.test(before)) return null;
	const query = upto.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { start: at, query };
}

/**
 * Debounced resource search for the mention popover. Returns the current results +
 * a loading flag; passing `null` clears results (popover closed). Stale responses are
 * dropped so fast typing never flashes an old list.
 */
export function useMentionSearch(anchor: MentionAnchor | null): {
	results: MentionResult[];
	loading: boolean;
} {
	const query = anchor?.query ?? null;
	const [results, setResults] = useState<MentionResult[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (query === null) {
			setResults([]);
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		const t = setTimeout(async () => {
			try {
				const r = await searchMentions(query);
				if (!cancelled) setResults(r);
			} catch {
				if (!cancelled) setResults([]);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}, 140);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [query]);

	return { results, loading };
}
