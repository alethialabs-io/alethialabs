// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The keyless cell table is the one thing the canvas gate, the canvas store and the deploy gate all
// read. These pin the properties those three depend on — above all TOTALITY, because "excluded by
// being absent from the table" is the exact shape of the bug #1510 fixes: alibaba and hetzner were
// never written down, and a lookup that misses therefore had to mean something, and what it meant in
// the canvas was "allowed".

import { describe, expect, it } from "vitest";
import { DB_CAPACITY, type CloudProviderSlug } from "@/lib/cloud-providers";
import {
	dbEngineFamily,
	keylessUnavailableReason,
	keylessUnavailableReasonForCloud,
	normalizeKeylessAuth,
} from "@/lib/cloud-providers/keyless";
import { KEYLESS_CELLS } from "@/lib/cloud-providers/generated/keyless-cells";

const ENGINES = ["postgres", "mysql"] as const;

describe("KEYLESS_CELLS", () => {
	it("covers every placeable cloud × both engines, with no holes", () => {
		// DB_CAPACITY is keyed on CloudProviderSlug — the clouds a database can actually be placed
		// on. Deriving the list rather than writing it means a new cloud fails here on the day it is
		// added, which is the only moment anyone would think to make the keyless decision.
		const slugs = Object.keys(DB_CAPACITY) as CloudProviderSlug[];
		expect(slugs.length).toBeGreaterThan(0);
		for (const slug of slugs) {
			for (const engine of ENGINES) {
				expect(
					KEYLESS_CELLS[slug]?.[engine],
					`${slug} × ${engine} has no keyless decision`,
				).toBeDefined();
			}
		}
	});

	it("gives every non-live cell the reason a user reads", () => {
		for (const [cloud, engines] of Object.entries(KEYLESS_CELLS)) {
			for (const [engine, cell] of Object.entries(engines)) {
				if (cell.state === "live") {
					// A live cell never refuses, so a reason on one would never be printed.
					expect(cell.reason, `${cloud} × ${engine}`).toBeUndefined();
				} else {
					expect(cell.reason?.trim(), `${cloud} × ${engine}`).toBeTruthy();
				}
			}
		}
	});
});

describe("dbEngineFamily", () => {
	it("normalizes the family, the legacy engine column, and the implicit default", () => {
		expect(dbEngineFamily({ engine_family: "mysql" })).toBe("mysql");
		expect(dbEngineFamily({ engine_family: "postgres" })).toBe("postgres");
		expect(dbEngineFamily({ engine: "aurora-mysql" })).toBe("mysql");
		expect(dbEngineFamily({ engine: "aurora-postgresql" })).toBe("postgres");
		// Neither set has always meant Postgres — packages/core's dbEngineForName agrees.
		expect(dbEngineFamily({})).toBe("postgres");
		expect(dbEngineFamily({ engine_family: null, engine: null })).toBe(
			"postgres",
		);
	});
});

describe("keylessUnavailableReason", () => {
	it("is null on the cells the renderer can build", () => {
		for (const provider of ["aws", "gcp", "azure"] as const) {
			for (const engine of ENGINES) {
				expect(keylessUnavailableReason(provider, engine)).toBeNull();
			}
		}
	});

	it("returns the excluded cell's reason", () => {
		expect(keylessUnavailableReason("hetzner", "postgres")).toMatch(
			/CloudNativePG/,
		);
		expect(keylessUnavailableReason("alibaba", "mysql")).toMatch(
			/control plane/,
		);
	});

	it("treats a null provider as 'not asked yet', not as a refusal", () => {
		// The field carries `requiresProvider`, which owns that case. Answering it here too would
		// give one question two owners and make the copy depend on which fired first.
		expect(keylessUnavailableReason(null, "postgres")).toBeNull();
	});

	it("REFUSES a cloud with no cell at all on the server side", () => {
		// The wide `cloud_provider` enum carries connect-only clouds with no project template. The
		// canvas can't reach them, but the deploy gate takes the wide type — and fail-open on an
		// unknown cloud is the wrong default for a setting that decides whether a password exists.
		expect(keylessUnavailableReasonForCloud("digitalocean", "postgres")).toMatch(
			/not available/i,
		);
		expect(keylessUnavailableReasonForCloud("aws", "mysql")).toBeNull();
		expect(keylessUnavailableReasonForCloud("hetzner", "postgres")).toMatch(
			/CloudNativePG/,
		);
	});
});

describe("normalizeKeylessAuth", () => {
	it("clears iam_auth on a cell that cannot honor it", () => {
		expect(
			normalizeKeylessAuth(
				{ iam_auth: true, engine_family: "postgres" },
				"hetzner",
			).iam_auth,
		).toBe(false);
		expect(
			normalizeKeylessAuth({ iam_auth: true, engine_family: "mysql" }, "alibaba")
				.iam_auth,
		).toBe(false);
	});

	it("leaves an honorable cell — and an already-off flag — alone", () => {
		const on = { iam_auth: true, engine_family: "mysql" };
		expect(normalizeKeylessAuth(on, "aws")).toBe(on); // same reference: no needless re-render
		const off = { iam_auth: false, engine_family: "postgres" };
		expect(normalizeKeylessAuth(off, "hetzner")).toBe(off);
	});

	it("does not clear it while no cloud is picked", () => {
		const draft = { iam_auth: true, engine_family: "postgres" };
		expect(normalizeKeylessAuth(draft, null)).toBe(draft);
	});
});
