// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// scripts/set-org-plan.mjs writes a GRANT: a row with no Stripe subscription (ADR 0004 D5), exactly as
// setOrgPlan does through upsertOrgBilling. #6019: the script's upsert never wrote
// `stripe_subscription_id`, so an org that had cancelled self-serve Team kept the old id on its granted
// row. The database is a recording stub of `postgres`; the script runs for real, to its process.exit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every tagged-template query the script issued, as its joined SQL text. */
const queries: string[] = [];

vi.mock("postgres", () => {
	/** A recording stand-in for the postgres tag: org lookup returns one row, the rest return nothing. */
	function fakeSql(strings: TemplateStringsArray): Promise<{ id: string; name: string }[]> | string {
		const text = strings.join("?");
		if (/^\s*(now\(\)|null)/.test(text) || text.startsWith("now() +")) return text;
		queries.push(text);
		return Promise.resolve(text.includes("from organization where") ? [{ id: "org_1", name: "Acme" }] : []);
	}
	fakeSql.end = () => Promise.resolve();
	return { default: () => fakeSql };
});

/** Runs the script with `args`, returning the exit code it asked for. */
async function runScript(args: string[]): Promise<number | undefined> {
	vi.resetModules();
	queries.length = 0;
	process.argv = ["node", "set-org-plan.mjs", ...args];
	let code: number | undefined;
	// Records the FIRST exit code and returns, so the script's own try/catch never sees a throw.
	vi.spyOn(process, "exit").mockImplementation((c) => {
		code ??= typeof c === "number" ? c : 0;
		return undefined as never;
	});
	await import("../../scripts/set-org-plan.mjs");
	await vi.waitFor(() => expect(code).toBeDefined());
	return code;
}

const original = { argv: process.argv, url: process.env.ALETHIA_DATABASE_URL };

beforeEach(() => {
	process.env.ALETHIA_DATABASE_URL = "postgres://stub";
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	process.argv = original.argv;
	if (original.url === undefined) delete process.env.ALETHIA_DATABASE_URL;
	else process.env.ALETHIA_DATABASE_URL = original.url;
	vi.restoreAllMocks();
});

describe("set-org-plan.mjs", () => {
	it("clears only the Stripe subscription id on conflict, keeping the customer id", async () => {
		expect(await runScript(["acme", "team", "--status", "past_due"])).toBe(0);
		const upsert = queries.find((q) => q.includes("on conflict"));
		expect(upsert).toBeDefined();
		expect(upsert).toMatch(/stripe_subscription_id\s*=\s*null/);
		expect(upsert).not.toMatch(/stripe_customer_id/);
		expect(upsert).not.toMatch(/seats/);
	});

	it("does not take the subscription id from the insert, so a fresh grant row has none either", async () => {
		await runScript(["acme", "enterprise", "--perpetual"]);
		const upsert = queries.find((q) => q.includes("insert into organization_billing")) ?? "";
		const columns = upsert.slice(0, upsert.indexOf("values"));
		expect(columns).toContain("organization_id");
		expect(columns).not.toContain("stripe_");
	});

	it("states in its usage text what it clears and keeps", async () => {
		expect(await runScript([])).toBe(1);
		const printed = vi.mocked(console.error).mock.calls.flat().join("\n");
		expect(printed).toMatch(/Clears stripe_subscription_id.*stripe_customer_id is kept/);
	});
});
