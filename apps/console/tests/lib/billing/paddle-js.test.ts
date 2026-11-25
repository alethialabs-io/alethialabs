// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle.js in the browser (lib/billing/paddle-js.ts): it is initialised once with the PUBLIC client
// token (sandbox when the server says so), opens the overlay on the server-created transaction id,
// and reports a completed payment once and a close without payment as a close.

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the Paddle.js global, capturing the event callback it was initialised with. */
function installPaddle() {
	const state: { callback: ((e: { name?: string }) => void) | null } = { callback: null };
	const paddle = {
		Environment: { set: vi.fn() },
		Initialize: vi.fn((opts: { token: string; eventCallback?: (e: { name?: string }) => void }) => {
			state.callback = opts.eventCallback ?? null;
		}),
		Checkout: { open: vi.fn() },
	};
	window.Paddle = paddle;
	return { paddle, emit: (name: string) => state.callback?.({ name }) };
}

beforeEach(() => {
	vi.resetModules();
	delete window.Paddle;
});

describe("openPaddleCheckout", () => {
	it("initialises once in sandbox and opens the overlay on the transaction id", async () => {
		const { paddle } = installPaddle();
		const { openPaddleCheckout } = await import("@/lib/billing/paddle-js");
		const callbacks = { onCompleted: vi.fn(), onClosed: vi.fn() };
		await openPaddleCheckout({ transactionId: "txn_1", clientToken: "test_tok", environment: "sandbox", ...callbacks });
		await openPaddleCheckout({ transactionId: "txn_2", clientToken: "test_tok", environment: "sandbox", ...callbacks });
		expect(paddle.Environment.set).toHaveBeenCalledWith("sandbox");
		expect(paddle.Initialize).toHaveBeenCalledTimes(1);
		expect(paddle.Initialize).toHaveBeenCalledWith(expect.objectContaining({ token: "test_tok" }));
		expect(paddle.Checkout.open).toHaveBeenLastCalledWith({ transactionId: "txn_2", settings: { displayMode: "overlay" } });
	});

	it("never switches a live checkout to sandbox", async () => {
		const { paddle } = installPaddle();
		const { openPaddleCheckout } = await import("@/lib/billing/paddle-js");
		await openPaddleCheckout({ transactionId: "txn_1", clientToken: "live_tok", environment: "live", onCompleted: vi.fn(), onClosed: vi.fn() });
		expect(paddle.Environment.set).not.toHaveBeenCalled();
	});

	it("reports completion, and a close after completion is not a close-without-payment", async () => {
		const { emit } = installPaddle();
		const { openPaddleCheckout } = await import("@/lib/billing/paddle-js");
		const onCompleted = vi.fn();
		const onClosed = vi.fn();
		await openPaddleCheckout({ transactionId: "txn_1", clientToken: "test_tok", environment: "sandbox", onCompleted, onClosed });
		emit("checkout.completed");
		emit("checkout.closed");
		expect(onCompleted).toHaveBeenCalledTimes(1);
		expect(onClosed).not.toHaveBeenCalled();
	});

	it("reports a close without payment", async () => {
		const { emit } = installPaddle();
		const { openPaddleCheckout } = await import("@/lib/billing/paddle-js");
		const onCompleted = vi.fn();
		const onClosed = vi.fn();
		await openPaddleCheckout({ transactionId: "txn_1", clientToken: "test_tok", environment: "sandbox", onCompleted, onClosed });
		emit("checkout.closed");
		emit("checkout.closed");
		expect(onClosed).toHaveBeenCalledTimes(1);
		expect(onCompleted).not.toHaveBeenCalled();
	});
});
