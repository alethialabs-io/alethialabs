// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 review: the walker the tenancy proof enumerates the read router with. A lazily-loaded
// procedure or sub-router is a symbol-keyed object, invisible to `Object.entries` — so the
// walker must RESOLVE it (and list its procedures) or THROW, never return nothing for it.

import { lazy, os } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { procedurePaths } from "@/lib/rpc/procedure-paths";

const proc = os.handler(() => "ok");

describe("procedurePaths", () => {
	it("lists eager procedures by dotted path", async () => {
		expect(await procedurePaths({ a: proc, b: { c: proc, d: {} } })).toEqual(["a", "b.c"]);
	});

	it("lists a LAZY procedure — never drops it", async () => {
		expect(await procedurePaths({ a: lazy(async () => ({ default: proc })) })).toEqual(["a"]);
	});

	it("lists the procedures inside a LAZY sub-router", async () => {
		const sub = lazy(async () => ({ default: { x: proc, y: { z: proc } } }));
		expect(await procedurePaths({ eager: proc, sub })).toEqual(["eager", "sub.x", "sub.y.z"]);
	});

	it("throws on a lazy root instead of answering empty", async () => {
		await expect(procedurePaths(lazy(async () => ({ default: { a: proc } })))).rejects.toThrow(/lazy router root/);
	});

	it("throws on a symbol-keyed node instead of answering empty", async () => {
		await expect(procedurePaths({ [Symbol("hidden")]: proc })).rejects.toThrow(/symbol-keyed/);
	});
});
