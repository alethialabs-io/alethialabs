// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pins that `pinWidget` validates through `pinInputSchema` (lib/ai/widget-schema.ts, #5683) BEFORE
// it resolves the owner or opens a transaction: a malformed pin never reaches the database. The
// owner lookup is mocked to throw a sentinel, so "reached the owner" is observable without a DB.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn() }));
vi.mock("@/lib/ai/tools", () => ({ buildAgentTools: vi.fn() }));

import { pinWidget, updateWidget } from "@/app/server/actions/widgets";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";

const PIN = {
	threadId: "11111111-1111-4111-8111-111111111111",
	kind: "stat" as const,
	title: "Clusters",
	data: { block: { kind: "stat" as const, title: "Clusters", value: 3 } },
	posX: 0,
	posY: 0,
	colspan: 1,
	rowspan: 1,
	mode: "frozen" as const,
};

const REACHED_OWNER = "reached requireOwner";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireOwner).mockRejectedValue(new Error(REACHED_OWNER));
});

describe("pinWidget — validation", () => {
	it("a valid pin passes the schema and goes on to resolve the owner", async () => {
		await expect(pinWidget(PIN)).rejects.toThrow(REACHED_OWNER);
		expect(requireOwner).toHaveBeenCalledTimes(1);
	});

	it("rejects an empty title before resolving the owner or touching the DB", async () => {
		await expect(pinWidget({ ...PIN, title: "" })).rejects.toBeInstanceOf(ZodError);
		expect(requireOwner).not.toHaveBeenCalled();
		expect(withOwnerScope).not.toHaveBeenCalled();
	});

	it("rejects a position outside the 5-column grid before resolving the owner", async () => {
		await expect(pinWidget({ ...PIN, posX: 5 })).rejects.toBeInstanceOf(ZodError);
		expect(requireOwner).not.toHaveBeenCalled();
	});

	it("rejects data the artifact widget schema rejects (the shared data schema)", async () => {
		const data = { block: { kind: "stat" as const, title: "Clusters", value: true } };
		// @ts-expect-error — a boolean value is outside the stat block's string | number.
		await expect(pinWidget({ ...PIN, data })).rejects.toBeInstanceOf(ZodError);
		expect(requireOwner).not.toHaveBeenCalled();
	});
});

describe("updateWidget — validation", () => {
	it("rejects an unknown mode before resolving the owner", async () => {
		// @ts-expect-error — "paused" is not a WidgetMode.
		await expect(updateWidget({ id: PIN.threadId, mode: "paused" })).rejects.toBeInstanceOf(ZodError);
		expect(requireOwner).not.toHaveBeenCalled();
	});

	it("a valid mode change passes the schema and goes on to resolve the owner", async () => {
		await expect(updateWidget({ id: PIN.threadId, mode: "live" })).rejects.toThrow(REACHED_OWNER);
		expect(requireOwner).toHaveBeenCalledTimes(1);
	});
});
