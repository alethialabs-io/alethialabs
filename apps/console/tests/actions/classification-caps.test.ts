// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// LST-9 (#7491): the classification taxonomy is read whole and unpaged, which holds only because the
// create actions cap it — CLASSIFICATION_DIMENSIONS_MAX per organization and
// CLASSIFICATION_VALUES_MAX per dimension — under a transaction lock taken BEFORE the count. The
// transaction is a fake that records what ran, in order, and answers the count it is told to.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	/** What the count query answers. */
	count: 0,
	/** What ran inside the transaction, in order. */
	log: [] as string[],
}));

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
}));

vi.mock("@/lib/db", () => {
	/** A select chain that resolves to `rows`, logging `label` when awaited. */
	const selectChain = (label: string, rows: () => unknown[]) => {
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			from: () => chain,
			where: () => chain,
			limit: () => chain,
			then: (resolve: (v: unknown) => void) => {
				h.log.push(label);
				resolve(rows());
			},
		});
		return chain;
	};
	const tx = {
		execute: async () => {
			h.log.push("lock");
			return [];
		},
		select: (shape: object) =>
			"n" in shape
				? selectChain("count", () => [{ n: h.count }])
				: selectChain("read-dimension", () => [{ id: "dim-1" }]),
		insert: () => {
			const chain: Record<string, unknown> = {};
			Object.assign(chain, {
				values: () => chain,
				returning: () => chain,
				then: (resolve: (v: unknown) => void) => {
					h.log.push("insert");
					resolve([{ id: "new-1" }]);
				},
			});
			return chain;
		},
	};
	return { withScope: async (_scope: unknown, fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
});

import {
	createDimension,
	createDimensionWithValues,
	createValue,
} from "@/app/server/actions/classification/dimensions";
import {
	CLASSIFICATION_DIMENSIONS_MAX,
	CLASSIFICATION_VALUES_MAX,
} from "@/lib/validations/classification";

const DIM = "5f0c1f3a-2b1e-4c6d-9a8b-7c6d5e4f3a2b";
const dimension = { key: "env", label: "Environment" };

beforeEach(() => {
	h.count = 0;
	h.log = [];
});

describe("createDimension — capped per organization", () => {
	it("locks, counts and inserts below the cap", async () => {
		h.count = CLASSIFICATION_DIMENSIONS_MAX - 1;
		const res = await createDimension(dimension);
		expect(res).toEqual({ ok: true, data: { id: "new-1" } });
		expect(h.log).toEqual(["lock", "count", "insert"]);
	});

	it("refuses at the cap, with a sentence, and writes nothing", async () => {
		h.count = CLASSIFICATION_DIMENSIONS_MAX;
		const res = await createDimension(dimension);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.kind).toBe("conflict");
		expect(JSON.stringify(res.error)).toContain(`${CLASSIFICATION_DIMENSIONS_MAX} classification dimensions`);
		expect(h.log).not.toContain("insert");
	});

	it("applies the same cap to a dimension created from a template", async () => {
		h.count = CLASSIFICATION_DIMENSIONS_MAX;
		const res = await createDimensionWithValues({ dimension, values: [] });
		expect(res.ok).toBe(false);
		expect(h.log).toEqual(["lock", "count"]);
	});
});

describe("createValue — capped per dimension", () => {
	it("checks the dimension, then locks and counts before inserting", async () => {
		h.count = CLASSIFICATION_VALUES_MAX - 1;
		const res = await createValue({ dimensionId: DIM, value: "dev", label: "Dev" });
		expect(res).toEqual({ ok: true, data: { id: "new-1" } });
		expect(h.log).toEqual(["read-dimension", "lock", "count", "insert"]);
	});

	it("refuses at the cap and writes nothing", async () => {
		h.count = CLASSIFICATION_VALUES_MAX;
		const res = await createValue({ dimensionId: DIM, value: "dev", label: "Dev" });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.kind).toBe("conflict");
		expect(h.log).not.toContain("insert");
	});
});
