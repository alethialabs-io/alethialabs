// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// orgSettingsForOrg / parseMeta — the by-id org settings read that moved out of the
// `"use server"` file (#5219). The action-level behaviour (personal scope, the address merge) is
// pinned in tests/actions/org-settings.test.ts; this file pins the read's own edges: a missing org,
// and a metadata blob that is absent or not JSON at all.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** Rows the next awaited SELECT resolves to. */
	const next: { rows: unknown[] } = { rows: [] };

	/** A drizzle-shaped SELECT builder: every step returns itself; awaiting it resolves `next.rows`. */
	class Chain implements PromiseLike<unknown[]> {
		/** Builder step (no-op). */
		select(): this {
			return this;
		}
		/** Builder step (no-op). */
		from(): this {
			return this;
		}
		/** Builder step (no-op). */
		where(): this {
			return this;
		}
		/** Builder step (no-op). */
		limit(): this {
			return this;
		}
		/** Resolves the scripted rows. */
		then<A = unknown[], B = never>(
			onFulfilled?: ((rows: unknown[]) => A | PromiseLike<A>) | null,
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
		): PromiseLike<A | B> {
			return Promise.resolve(next.rows).then(onFulfilled, onRejected);
		}
	}
	return { db: { select: () => new Chain() }, next };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));

import { orgSettingsForOrg, parseMeta } from "@/lib/org/settings";

const DEFAULTS = {
	description: "",
	primaryAddress: null,
	region: "eu-west-1",
	defaultEnv: "staging",
	terraformVersion: "1.9.5",
};

beforeEach(() => {
	fake.next.rows = [];
});

describe("orgSettingsForOrg", () => {
	it("is null when the org row is missing", async () => {
		await expect(orgSettingsForOrg("org-x")).resolves.toBeNull();
	});

	it("falls back to the defaults when the metadata is not JSON", async () => {
		fake.next.rows = [{ name: "Acme", slug: null, logo: null, metadata: "{not json" }];
		await expect(orgSettingsForOrg("org-1")).resolves.toEqual({
			name: "Acme",
			slug: "",
			logo: null,
			...DEFAULTS,
		});
	});
});

describe("parseMeta", () => {
	it("reads an absent blob as empty", () => {
		expect(parseMeta(null)).toEqual({});
	});

	it("keeps the fields it can read and drops a malformed one", () => {
		expect(parseMeta(JSON.stringify({ region: "us-east-1", defaultEnv: 7 }))).toEqual({
			region: "us-east-1",
		});
	});
});
