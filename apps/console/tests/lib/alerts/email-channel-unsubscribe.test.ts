// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The alert email channel's per-recipient mute and RFC 8058 headers (lib/alerts/channels/email.ts).
//
// Pinned: a recipient who muted THIS channel is skipped while the others still get it; every
// message carries its own recipient's one-click `List-Unsubscribe` + `List-Unsubscribe-Post`, and a
// body link to the same choice.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, wants } = vi.hoisted(() => ({ send: vi.fn(), wants: vi.fn() }));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: (...a: unknown[]) => send(...a) }));
vi.mock("@repo/email/config", () => ({
	getEmailConfig: () => ({ from: { general: "hello@example.io" }, configSet: { general: "general" } }),
}));
vi.mock("@/emails/alert", () => ({ AlertEmail: (props: unknown) => ({ props }) }));
vi.mock("@/lib/email/preferences", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/email/preferences")>();
	return {
		alertChannelCategory: actual.alertChannelCategory,
		wantsEmail: (...a: unknown[]) => wants(...a),
		oneClickUnsubscribeUrl: (c: { email: string }) => `https://x/api/email/unsubscribe?for=${c.email}`,
		unsubscribePageUrl: (c: { email: string }) => `https://x/email/unsubscribe?for=${c.email}`,
	};
});

import type { AlertChannel } from "@/lib/db/schema";
import { emailSender } from "@/lib/alerts/channels/email";

const CHANNEL_ID = "44444444-4444-4444-4444-444444444444";
const channel = {
	id: CHANNEL_ID,
	config: { recipients: ["a@example.io", "b@example.io"] },
} as unknown as AlertChannel;

beforeEach(() => {
	send.mockReset();
	send.mockResolvedValue(undefined);
	wants.mockReset();
});

describe("alert email per-recipient mute", () => {
	it("skips the recipient who muted this channel and sends the rest", async () => {
		wants.mockImplementation(async (email: string) => email !== "a@example.io");
		await emailSender.send(channel, { title: "Deploy failed", severity: "critical" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0].to).toBe("b@example.io");
		expect(wants).toHaveBeenCalledWith("a@example.io", `alert_channel:${CHANNEL_ID}`);
	});

	it("gives each message its own recipient's one-click unsubscribe", async () => {
		wants.mockResolvedValue(true);
		await emailSender.send(channel, { title: "Deploy failed", severity: "critical" });
		const headers = send.mock.calls.map((c) => c[0].headers);
		expect(headers[0]).toEqual({
			"List-Unsubscribe": "<https://x/api/email/unsubscribe?for=a@example.io>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		});
		expect(headers[1]["List-Unsubscribe"]).toContain("b@example.io");
		expect(send.mock.calls[0]?.[0].react.props.unsubscribeUrl).toBe("https://x/email/unsubscribe?for=a@example.io");
	});
});
