// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6757: every data poll left in the console names the unit that lifts it. `check:no-polling`
// (scripts/check-no-polling.mjs) keeps the ledger true to the tree and lets the polls only shrink,
// but its `lifts` rule still accepts the word "unassigned". This reads the ledger itself and
// refuses it, so a poll with no owner fails here.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const LEDGER = resolve(dirname(fileURLToPath(import.meta.url)), "../../../no-polling-ledger.json");

const ledgerSchema = z.object({
	polls: z.record(z.string(), z.object({ count: z.number(), lifts: z.string() })),
});

describe("no-polling-ledger.json", () => {
	const ledger = ledgerSchema.parse(JSON.parse(readFileSync(LEDGER, "utf8")));

	it("names an issue for every poll: no entry is unassigned", () => {
		const unowned = Object.entries(ledger.polls)
			.filter(([, entry]) => !/^#\d+$/.test(entry.lifts))
			.map(([key]) => key);
		expect(unowned).toEqual([]);
	});
});
