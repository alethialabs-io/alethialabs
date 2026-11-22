// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Ask-AI conversation kept in the tab (G-10): read back for the same viewer and org, never for
// another viewer, dropped when stale or malformed, and cleared with the other drafts on sign-out.

import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ASK_TRANSCRIPT_TTL_MS,
	askTranscriptAddress,
	askTranscriptKey,
	clearAskTranscript,
	readAskTranscript,
	writeAskTranscript,
} from "@/components/support/ask/ask-transcript";
import { clearAllWizardDrafts } from "@/lib/wizard/draft";

const NOW = 1_800_000_000_000;

const MESSAGES: UIMessage[] = [
	{ id: "m1", role: "user", parts: [{ type: "text", text: "Why did my cluster fail?" }] },
	{ id: "m2", role: "assistant", parts: [{ type: "text", text: "The quota was reached." }] },
];

beforeEach(() => {
	sessionStorage.clear();
});

describe("ask transcript", () => {
	it("reads back what was written for the same viewer and org", () => {
		const address = askTranscriptAddress("u1", "acme");
		writeAskTranscript(address, MESSAGES, NOW);
		expect(readAskTranscript(address, NOW + 1000)).toEqual(MESSAGES);
	});

	it("never reads another viewer's conversation, and removes it", () => {
		writeAskTranscript(askTranscriptAddress("u1", "acme"), MESSAGES, NOW);
		expect(readAskTranscript(askTranscriptAddress("u2", "acme"), NOW)).toEqual([]);
		expect(sessionStorage.getItem(askTranscriptKey(askTranscriptAddress("u1", "acme")))).toBeNull();
	});

	it("keeps one conversation per org", () => {
		writeAskTranscript(askTranscriptAddress("u1", "acme"), MESSAGES, NOW);
		expect(readAskTranscript(askTranscriptAddress("u1", "globex"), NOW)).toEqual([]);
	});

	it("drops a conversation older than the TTL or dated in the future", () => {
		const address = askTranscriptAddress("u1", "acme");
		writeAskTranscript(address, MESSAGES, NOW);
		expect(readAskTranscript(address, NOW + ASK_TRANSCRIPT_TTL_MS + 1)).toEqual([]);
		writeAskTranscript(address, MESSAGES, NOW);
		expect(readAskTranscript(address, NOW - 1)).toEqual([]);
	});

	it("drops a stored value that is not a list of messages", () => {
		const address = askTranscriptAddress("u1", "acme");
		const key = askTranscriptKey(address);
		const bad = [
			"not json",
			JSON.stringify({ v: 1, at: NOW, messages: [{ id: 1, role: "user", parts: [] }] }),
			JSON.stringify({ v: 1, at: NOW, messages: [{ id: "m", role: "robot", parts: [] }] }),
			JSON.stringify({ v: 2, at: NOW, messages: [] }),
		];
		const kept = bad.filter((text) => {
			sessionStorage.setItem(key, text);
			return readAskTranscript(address, NOW).length > 0 || sessionStorage.getItem(key) !== null;
		});
		expect(kept).toEqual([]);
	});

	it("an empty conversation and New conversation both remove the stored one", () => {
		const address = askTranscriptAddress("u1", "acme");
		writeAskTranscript(address, MESSAGES, NOW);
		writeAskTranscript(address, [], NOW);
		expect(sessionStorage.getItem(askTranscriptKey(address))).toBeNull();
		writeAskTranscript(address, MESSAGES, NOW);
		clearAskTranscript(address);
		expect(sessionStorage.getItem(askTranscriptKey(address))).toBeNull();
	});

	it("is cleared with the wizard drafts on sign-out", () => {
		const address = askTranscriptAddress("u1", "acme");
		writeAskTranscript(address, MESSAGES, NOW);
		clearAllWizardDrafts();
		expect(readAskTranscript(address, NOW)).toEqual([]);
	});
});
