// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ChatError's provider kinds (#6616). A chat route's stream error text is one of the shared
// constants in `lib/ai/provider-error.ts`; `useChat` hands it over as `error.message`. Each constant
// must render its own card: the two that only an administrator can fix (no credit, rejected key)
// name who fixes it and offer NO Retry, and a busy provider keeps Retry.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics/track";
import { ChatError } from "@/components/agent/chat-error";
import { PROVIDER_ERROR_MESSAGES } from "@/lib/ai/provider-error";

vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/app/server/actions/billing", () => ({ getAiUsageSummary: vi.fn() }));
vi.mock("@/components/billing/upgrade-ai-sheet", () => ({ UpgradeAiSheet: () => null }));
vi.mock("@/components/billing/credit-pack-dialog", () => ({ CreditPackDialog: () => null }));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ChatError — provider kinds", () => {
	it("shows an out-of-credit provider account as an administrator's job, with no Retry", () => {
		render(
			<ChatError error={new Error(PROVIDER_ERROR_MESSAGES["provider-billing"])} onRetry={vi.fn()} />,
		);
		expect(screen.getByText("The AI provider account is out of credit")).toBeInTheDocument();
		expect(screen.getByText(/an administrator of this deployment needs to top it up/i)).toBeInTheDocument();
		expect(screen.getByText(/retrying does not help/i)).toBeInTheDocument();
		// Not the AI-plan budget card, although the constant says "credit".
		expect(screen.queryByText("AI limit reached")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /upgrade ai plan|buy credits/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
		expect(vi.mocked(track)).toHaveBeenCalledWith("elench_error", { kind: "provider-billing" });
	});

	it("shows a rejected API key as an administrator's job, with no Retry", () => {
		render(<ChatError error={new Error(PROVIDER_ERROR_MESSAGES["provider-auth"])} onRetry={vi.fn()} />);
		expect(screen.getByText("The AI provider rejected the API key")).toBeInTheDocument();
		expect(screen.getByText(/an administrator of this deployment needs to check the key/i)).toBeInTheDocument();
		expect(screen.queryByText("AI is not configured")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
		expect(vi.mocked(track)).toHaveBeenCalledWith("elench_error", { kind: "provider-auth" });
	});

	it("shows a busy provider as transient, and keeps a Retry that invokes onRetry", async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		render(
			<ChatError error={new Error(PROVIDER_ERROR_MESSAGES["provider-overloaded"])} onRetry={onRetry} />,
		);
		expect(screen.getByText("The AI provider is busy")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /retry/i }));
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(vi.mocked(track)).toHaveBeenCalledWith("elench_error", { kind: "provider-overloaded" });
	});

	it("still reads the network constant as the transient network card, with Retry", () => {
		render(<ChatError error={new Error(PROVIDER_ERROR_MESSAGES.network)} onRetry={vi.fn()} />);
		expect(screen.getByText("The assistant hit an error")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});
});
