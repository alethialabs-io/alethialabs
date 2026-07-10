// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for ChatError: it classifies a useChat error into missing-key / budget /
// network (generic falls to network) and renders the matching title plus an always-present
// Retry that invokes the callback. On a budget error the CTA is tier-aware (packs are
// paid-only), so the summary fetch is mocked per test. The analytics track() call in the
// mount effect is mocked.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics/track";
import { ChatError } from "@/components/agent/chat-error";

vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
// ChatError fetches the AI summary to pick the tier-aware budget CTA.
vi.mock("@/app/server/actions/billing", () => ({ getAiUsageSummary: vi.fn() }));
// The CTAs open the shared purchase surfaces (Stripe + server actions) — stubbed here;
// they're covered by their own tests. This keeps ChatError focused on classify + CTA.
vi.mock("@/components/billing/upgrade-ai-sheet", () => ({
	UpgradeAiSheet: () => null,
}));
vi.mock("@/components/billing/credit-pack-dialog", () => ({
	CreditPackDialog: () => null,
}));

import { getAiUsageSummary } from "@/app/server/actions/billing";

/** Mock the summary fetch to resolve the given tier (the only field ChatError reads). */
function mockTier(tier: "ai_free" | "ai_plus" | "ai_max") {
	vi.mocked(getAiUsageSummary).mockResolvedValue({ tier } as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockTier("ai_free");
});

describe("ChatError", () => {
	it("classifies a 503 'not configured' body as missing-key", () => {
		render(
			<ChatError
				error={new Error("AI is not configured. Set ANTHROPIC_API_KEY to enable the agent.")}
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

	it("renders the parsed 402 message + reset time, with Buy credits on a PAID tier", async () => {
		mockTier("ai_plus");
		const resetAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
		render(
			<ChatError
				error={
					new Error(
						JSON.stringify({
							error: "You're out of included AI usage for this week.",
							reason: "weekly",
							resetAt,
							upgradable: true,
						}),
					)
				}
			/>,
		);
		expect(
			screen.getByText(/out of included AI usage for this week.*Resets in/i),
		).toBeInTheDocument();
		// Paid tiers may top up — the limit CTA opens the Buy-credits dialog.
		expect(
			await screen.findByRole("button", { name: /buy credits/i }),
		).toBeInTheDocument();
	});

	it("offers Upgrade (never Buy credits) to a FREE tier at its limit", async () => {
		mockTier("ai_free");
		render(
			<ChatError
				error={
					new Error(
						'{"error":"out of usage","reason":"session","resetAt":null,"upgradable":true}',
					)
				}
			/>,
		);
		expect(
			await screen.findByRole("button", { name: /upgrade ai plan/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /buy credits/i }),
		).not.toBeInTheDocument();
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
			screen.getByRole("button", { name: /upgrade ai plan/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /buy credits/i }),
		).not.toBeInTheDocument();
	});

	it("keeps Retry alongside the budget CTA (legacy 'daily' reason still parses)", async () => {
		mockTier("ai_max");
		const onRetry = vi.fn();
		render(
			<ChatError
				error={
					new Error('{"error":"out of usage","reason":"daily","resetAt":null,"upgradable":true}')
				}
				onRetry={onRetry}
			/>,
		);
		expect(await screen.findByRole("button", { name: /buy credits/i })).toBeInTheDocument();
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
		render(<ChatError error={new Error("Set ANTHROPIC_API_KEY")} />);
		expect(vi.mocked(track)).toHaveBeenCalledWith("elench_error", {
			kind: "missing-key",
		});
	});
});
