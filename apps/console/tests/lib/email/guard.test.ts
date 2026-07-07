// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// sendGuardedEmail: suppression-aware wrapper over @repo/email's sendEmail. Verifies a
// suppressed primary recipient is skipped entirely, and that suppressed CC addresses are
// filtered out while clean ones pass through (the cc plumbing added for support ccEmails).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/email/send", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/email/suppression", () => ({ isSuppressed: vi.fn() }));

import { sendGuardedEmail } from "@/lib/email/guard";
import { isSuppressed } from "@/lib/email/suppression";
import { sendEmail } from "@repo/email/send";

/** Minimal valid args (react can be any element — sendEmail is mocked). */
const base = {
	from: "hello@mail.alethialabs.io",
	subject: "Test",
	react: null as never,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(sendEmail).mockResolvedValue(undefined);
	// Default: nobody suppressed.
	vi.mocked(isSuppressed).mockResolvedValue(false);
});

describe("sendGuardedEmail", () => {
	it("skips the send entirely when the primary recipient is suppressed", async () => {
		vi.mocked(isSuppressed).mockImplementation(
			async (addr: string) => addr === "ada@acme.io",
		);
		await sendGuardedEmail({ ...base, to: "ada@acme.io" });
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("passes a clean cc list straight through", async () => {
		await sendGuardedEmail({
			...base,
			to: "ada@acme.io",
			cc: ["cto@acme.io", "sre@acme.io"],
		});
		expect(sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ to: "ada@acme.io", cc: ["cto@acme.io", "sre@acme.io"] }),
		);
	});

	it("drops a suppressed cc address but keeps the clean ones", async () => {
		vi.mocked(isSuppressed).mockImplementation(
			async (addr: string) => addr === "cto@acme.io",
		);
		await sendGuardedEmail({
			...base,
			to: "ada@acme.io",
			cc: ["cto@acme.io", "sre@acme.io"],
		});
		expect(sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ cc: ["sre@acme.io"] }),
		);
	});

	it("sets cc to undefined when every cc address is suppressed", async () => {
		vi.mocked(isSuppressed).mockImplementation(
			async (addr: string) => addr !== "ada@acme.io",
		);
		await sendGuardedEmail({ ...base, to: "ada@acme.io", cc: ["cto@acme.io"] });
		const arg = vi.mocked(sendEmail).mock.calls[0]?.[0];
		expect(arg?.cc).toBeUndefined();
	});

	it("leaves cc absent when none was provided", async () => {
		await sendGuardedEmail({ ...base, to: "ada@acme.io" });
		const arg = vi.mocked(sendEmail).mock.calls[0]?.[0];
		expect(arg?.cc).toBeUndefined();
	});
});
