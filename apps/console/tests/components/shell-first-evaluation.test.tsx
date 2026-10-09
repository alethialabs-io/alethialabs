// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5849: what the app shell makes the browser EVALUATE before a page can hydrate.
//
// Every private page mounts the shell, and the browser has to run every module in the shell's
// static graph before React can hydrate anything or even listen for a click. On a cold load in CI
// that was one ~470 ms task (release-gate run 37917147461), and a click on a filter-bar control
// 300 ms after the page painted was lost on 4 of 4 Activity loads. Two things in that graph did
// nothing on first paint: the Elench conversation (the whole chat, markdown, code-highlighting and
// canvas-preview stack, rendered only once the assistant is opened) and Stripe.js (which the
// package root injects as a side effect of being imported). These tests hold both out.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const evaluated = vi.hoisted(() => ({ conversation: 0 }));

// Counts evaluations of the conversation module. A static import from the surface evaluates this
// factory the moment the surface is imported — before anything is opened.
vi.mock("@/components/agent/elench/elench-conversation", () => {
	evaluated.conversation += 1;
	return { ElenchConversation: () => <div data-testid="conversation" /> };
});
vi.mock("@/components/agent/elench/use-elench-threads", () => ({
	useElenchThreads: () => ({}),
}));

import { ElenchSurface } from "@/components/agent/elench/elench-surface";
import { useElenchStore } from "@/lib/stores/use-elench-store";

const INITIAL = useElenchStore.getState();

afterEach(() => {
	useElenchStore.setState(INITIAL, true);
	document.querySelectorAll("script").forEach((s) => s.remove());
});

describe("the app shell's first evaluation (#5849)", () => {
	it("does not evaluate the Elench conversation until the assistant is opened", async () => {
		const view = render(<ElenchSurface />);
		await act(async () => {});
		expect(evaluated.conversation).toBe(0);
		expect(view.queryByTestId("conversation")).toBeNull();

		act(() => useElenchStore.getState().openPanel({ kind: "org" }));
		expect(await view.findByTestId("conversation")).toBeTruthy();
		expect(evaluated.conversation).toBe(1);
	});

	it("does not inject Stripe.js when the Stripe client module is imported", async () => {
		await import("@/lib/billing/stripe-client");
		// The package root schedules its injection on a resolved promise; let it run.
		await act(async () => {});
		await new Promise((r) => setTimeout(r, 0));
		expect(document.querySelector('script[src*="js.stripe.com"]')).toBeNull();
	});
});
