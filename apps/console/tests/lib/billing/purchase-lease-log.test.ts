// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `withPurchaseLease` logs a release that fails rather than throwing it (the lease lapses on its own).
// That log goes through the structured logger with the caught error under `err`, so the logger's `err`
// serializer decides what is written — not `console.error`, which writes the whole error unexamined.

import { describe, expect, it, vi } from "vitest";

/** The holder the fake insert was given, echoed back by `returning` so the acquire succeeds. */
const state = vi.hoisted(() => ({ holder: "" }));
/** The error the fake delete throws: the release fails. */
const releaseError = vi.hoisted(() => new Error("connection reset"));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		insert: () => ({
			values: (row: { holder: string }) => {
				state.holder = row.holder;
				return {
					onConflictDoUpdate: () => ({
						returning: async () => [{ holder: state.holder }],
					}),
				};
			},
		}),
		delete: () => ({
			where: async () => {
				throw releaseError;
			},
		}),
	}),
}));

import { withPurchaseLease } from "@/lib/billing/purchase-lease";
import { log } from "@/lib/observability/log";

describe("withPurchaseLease: a failed release", () => {
	it("returns fn's value and logs the caught error under `err`", async () => {
		const logged = vi.spyOn(log, "error").mockImplementation(() => {});
		await expect(withPurchaseLease("org-plan:org_1", async () => 7, 0)).resolves.toEqual({ acquired: true, value: 7 });
		expect(logged).toHaveBeenCalledWith(
			"[billing] could not release the purchase lease org-plan:org_1; it lapses on its own",
			{ err: releaseError },
		);
		logged.mockRestore();
	});
});
