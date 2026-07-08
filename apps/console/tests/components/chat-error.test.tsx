// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for ChatError: it classifies a useChat error into missing-key / budget /
// network (generic falls to network) and renders the matching title plus an always-present
// Retry that invokes the callback. The analytics track() call in the mount effect is mocked.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics/track";
import { ChatError } from "@/components/agent/chat-error";

vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

describe("ChatError", () => {
	it("classifies a 503 'not configured' body as missing-key", () => {
		render(
			<ChatError
				error={new Error("AI is not configured. Set AI_GATEWAY_API_KEY to enable the agent.")}
			/>,
		);
		expect(screen.getByText("AI is not configured")).toBeInTheDocument();
	});

	it("classifies a 402 budget/quota body as budget", () => {
		render(
			<ChatError
				error={new Error('{"error":"blocked","reason":"weekly"}')}
			/>,
		);
		expect(screen.getByText("AI limit reached")).toBeInTheDocument();
	});

	it("renders the parsed 402 message + reset time and a Buy credits CTA for a weekly cap", () => {
		const resetAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
		render(
			<ChatError
				error={
					new Error(
						JSON.stringify({
							error: "You're out of AI usage for this week.",
							reason: "weekly",
							resetAt,
							upgradable: true,
						}),
					)
				}
			/>,
		);
		expect(
			screen.getByText(/out of AI usage for this week.*Resets in/i),
		).toBeInTheDocument();
		const cta = screen.getByRole("link", { name: /buy credits/i });
		expect(cta).toHaveAttribute("href", expect.stringContaining("/settings/billing"));
	});

	it("shows an Upgrade AI plan CTA when the reason is not_enabled (subscribe)", () => {
		render(
			<ChatError
				error={
					new Error(
						JSON.stringify({
							error: "AI features are not enabled for this workspace.",
							reason: "not_enabled",
							resetAt: null,
							upgradable: true,
						}),
					)
				}
			/>,
		);
		expect(
			screen.getByRole("link", { name: /upgrade ai plan/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /buy credits/i }),
		).not.toBeInTheDocument();
	});

	it("keeps Retry alongside the budget CTA", () => {
		const onRetry = vi.fn();
		render(
			<ChatError
				error={
					new Error('{"error":"out of usage","reason":"daily","resetAt":null,"upgradable":true}')
				}
				onRetry={onRetry}
			/>,
		);
		expect(screen.getByRole("link", { name: /buy credits/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});

	it("classifies a dropped fetch (generic TypeError) as network", () => {
		render(<ChatError error={new TypeError("Failed to fetch")} />);
		expect(screen.getByText("The assistant hit an error")).toBeInTheDocument();
	});

	it("always offers a Retry that invokes onRetry", async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		render(<ChatError error={new Error("Failed to fetch")} onRetry={onRetry} />);
		const retry = screen.getByRole("button", { name: /retry/i });
		expect(retry).toBeInTheDocument();
		await user.click(retry);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("omits the Retry button when no onRetry is given", () => {
		render(<ChatError error={new Error("AI is not configured")} />);
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
	});

	it("reports the surfaced error kind to analytics (kind only, no raw message)", () => {
		render(<ChatError error={new Error("Set AI_GATEWAY_API_KEY")} />);
		expect(vi.mocked(track)).toHaveBeenCalledWith("elench_error", {
			kind: "missing-key",
		});
	});
});
