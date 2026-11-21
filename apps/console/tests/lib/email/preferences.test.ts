// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Email preferences and their signed unsubscribe links (lib/email/preferences.ts).
//
// Pinned: a token names one address and one category and nothing else can be read out of a
// tampered one; product updates are OFF until chosen and an alert channel ON until muted; a stored
// choice wins over the default; and a one-click unsubscribe is a POST URL, distinct from the page.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../privacy/scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));
vi.mock("@/lib/config/auth", () => ({
	getAuthConfig: () => ({ secret: "s".repeat(40), baseURL: "https://console.example.io" }),
}));

import { emailPreference } from "@/lib/db/schema";
import {
	alertChannelCategory,
	defaultEnabled,
	isEmailCategory,
	oneClickUnsubscribeUrl,
	readUnsubscribeToken,
	setEmailPreference,
	unsubscribePageUrl,
	unsubscribeToken,
	wantsEmail,
} from "@/lib/email/preferences";

const CHANNEL = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
	sdb.calls.length = 0;
});

describe("unsubscribe tokens", () => {
	it("round-trip one address and one category, with the address normalised", () => {
		const token = unsubscribeToken({ email: " Ada@Example.IO ", category: alertChannelCategory(CHANNEL) });
		expect(readUnsubscribeToken(token)).toEqual({
			email: "ada@example.io",
			category: `alert_channel:${CHANNEL}`,
		});
	});

	it("refuse a tampered payload, a tampered signature and a malformed token", () => {
		const token = unsubscribeToken({ email: "ada@example.io", category: "product_updates" });
		const [payload, mac] = token.split(".");
		const forged = Buffer.from(JSON.stringify({ v: 1, e: "eve@example.io", c: "product_updates" })).toString(
			"base64url",
		);
		expect(readUnsubscribeToken(`${forged}.${mac}`)).toBeNull();
		expect(readUnsubscribeToken(`${payload}.${mac?.slice(0, -2)}xx`)).toBeNull();
		expect(readUnsubscribeToken("not-a-token")).toBeNull();
		expect(readUnsubscribeToken(`${token}.extra`)).toBeNull();
	});

	it("point the header at the POST endpoint and the body link at the confirmation page", () => {
		const claim = { email: "ada@example.io", category: "product_updates" as const };
		expect(oneClickUnsubscribeUrl(claim)).toMatch(/^https:\/\/console\.example\.io\/api\/email\/unsubscribe\?t=/);
		expect(unsubscribePageUrl(claim)).toMatch(/^https:\/\/console\.example\.io\/email\/unsubscribe\?t=/);
	});
});

describe("categories and defaults", () => {
	it("accept only the known categories", () => {
		expect(isEmailCategory("product_updates")).toBe(true);
		expect(isEmailCategory(`alert_channel:${CHANNEL}`)).toBe(true);
		expect(isEmailCategory("alert_channel:not-a-uuid")).toBe(false);
		expect(isEmailCategory("marketing")).toBe(false);
	});

	it("keep product updates off and alert channels on until someone chooses", () => {
		expect(defaultEnabled("product_updates")).toBe(false);
		expect(defaultEnabled(alertChannelCategory(CHANNEL))).toBe(true);
	});
});

describe("wantsEmail", () => {
	it("reads the default when the address never chose", async () => {
		sdb.answer([]);
		expect(await wantsEmail("ada@example.io", "product_updates")).toBe(false);
		sdb.answer([]);
		expect(await wantsEmail("ada@example.io", alertChannelCategory(CHANNEL))).toBe(true);
	});

	it("honours a stored mute over the default", async () => {
		sdb.answer([{ enabled: false }]);
		expect(await wantsEmail("ada@example.io", alertChannelCategory(CHANNEL))).toBe(false);
	});
});

describe("setEmailPreference", () => {
	it("links the row to the account that owns the address, and upserts on address + category", async () => {
		sdb.answer([{ id: "user-1" }], []);
		await setEmailPreference({
			email: "Ada@Example.io",
			category: "product_updates",
			enabled: false,
			source: "one_click",
		});
		const insert = sdb.calls.find((c) => c.op === "insert" && c.table === emailPreference);
		expect(insert?.values).toEqual({
			email: "ada@example.io",
			category: "product_updates",
			enabled: false,
			source: "one_click",
			user_id: "user-1",
		});
	});
});
