// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// search_docs — grounds elench's answers in the real documentation (connectors, architecture, how-to,
// CLI, self-hosting) instead of improvising. Lexical TF-IDF ranking over a committed index built from
// apps/docs (scripts/gen-docs-index.mjs); an embedding index can swap in behind rankDocs later.

import { tool } from "ai";
import { z } from "zod";
import indexJson from "../docs-index.generated.json";

interface DocRecord {
	id: string;
	route: string;
	url: string;
	title: string;
	heading: string;
	text: string;
}

const RECORDS: DocRecord[] = (indexJson as { records: DocRecord[] }).records;

const STOP = new Set([
	"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "how", "do", "i",
	"my", "with", "it", "this", "that", "you", "your", "can", "does", "what", "when", "as", "at",
]);

function tokenize(s: string): string[] {
	return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Precomputed per-record term data for fast scoring. */
interface Indexed {
	rec: DocRecord;
	tf: Map<string, number>;
	head: Set<string>;
	title: Set<string>;
}

const INDEXED: Indexed[] = RECORDS.map((rec) => {
	const tf = new Map<string, number>();
	for (const t of tokenize(rec.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
	return { rec, tf, head: new Set(tokenize(rec.heading)), title: new Set(tokenize(rec.title)) };
});

const N = INDEXED.length || 1;
const DF = new Map<string, number>();
for (const doc of INDEXED) {
	const seen = new Set<string>([...doc.tf.keys(), ...doc.head, ...doc.title]);
	for (const t of seen) DF.set(t, (DF.get(t) ?? 0) + 1);
}

/** Robertson–Spärck-Jones idf — downweights terms common across the corpus. */
function idf(term: string): number {
	const d = DF.get(term) ?? 0;
	return Math.log(1 + (N - d + 0.5) / (d + 0.5));
}

/** Ranks doc chunks against a query (TF-IDF + heading/title boosts). Exported for testing. */
export function rankDocs(query: string, topK: number): DocRecord[] {
	const qterms = [...new Set(tokenize(query))].filter((t) => t.length > 1 && !STOP.has(t));
	if (qterms.length === 0) return [];

	return INDEXED.map((doc) => {
		let score = 0;
		for (const t of qterms) {
			const w = idf(t);
			const tf = doc.tf.get(t) ?? 0;
			if (tf > 0) score += w * (1 + Math.log(tf));
			if (doc.head.has(t)) score += 2 * w;
			if (doc.title.has(t)) score += 1.5 * w;
		}
		return { rec: doc.rec, score };
	})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)
		.map((x) => x.rec);
}

/** The docs-retrieval tool set. */
export function docsTools() {
	return {
		search_docs: tool({
			description:
				"Search the Alethia documentation (connectors, keyless OIDC auth, architecture, how-to, CLI, self-hosting). GROUND factual / how-to answers with this — especially 'how do I connect <cloud>', how connectors or keyless auth work, and platform behavior — instead of guessing. Returns the most relevant doc chunks with their URLs to cite.",
			inputSchema: z.object({
				query: z.string().describe("A natural-language question or keywords."),
				topK: z.number().int().min(1).max(8).optional().describe("How many chunks to return (default 4)."),
			}),
			execute: async ({ query, topK }) => {
				const hits = rankDocs(query, topK ?? 4);
				return {
					results: hits.map((h) => ({
						title: h.title,
						heading: h.heading || null,
						url: h.url,
						snippet: h.text.slice(0, 600),
					})),
				};
			},
		}),
	};
}
