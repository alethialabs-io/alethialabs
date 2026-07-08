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
				error={new Error('{"error":"blocked","reason":"weekly budget exhausted"}')}
			/>,
		);
		expect(screen.getByText("AI limit reached")).toBeInTheDocument();
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
