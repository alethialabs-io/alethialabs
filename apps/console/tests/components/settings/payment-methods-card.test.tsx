// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Payment methods section (CON-L3). Pins:
//   · R6 F-09: a 3-D Secure return that did NOT succeed says so and reopens the add-card dialog
//     with the same SetupIntent; it used to strip the params and say nothing;
//   · a successful return still records the save exactly as before;
//   · removing a card goes through the console's one confirmation, which closes only on success.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/actions/result";
import type { PaymentMethodInfo } from "@/lib/rpc/procedures/billing";

const { removeCard, recordCardSaved, toast } = vi.hoisted(() => ({
	removeCard: vi.fn<(raw: { pmId: string }) => Promise<ActionResult<{ ok: true }>>>(),
	recordCardSaved: vi.fn<(raw: { setupIntentId: string }) => Promise<unknown>>(),
	toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./billing-rpc-fake")).fakeOrpc }));
vi.mock("@/app/server/actions/billing", () => ({
	makeDefaultCard: vi.fn(),
	saveBackupCards: vi.fn(),
	removeCard,
	recordCardSaved,
	startAddCard: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: ({ clientSecret }: { clientSecret: string }) => (
		<div data-testid="stripe-elements" data-client-secret={clientSecret} />
	),
}));
vi.mock("@/components/billing/payment-form", () => ({ PaymentForm: () => null }));

import {
	PaymentMethodsCard,
	readSetupReturn,
	SETUP_FAILED_MESSAGE,
} from "@/components/settings/billing/payment-methods-card";
import { reads, renderWithReads, resetReads } from "./billing-rpc-fake";

const card = (over: Partial<PaymentMethodInfo> = {}): PaymentMethodInfo => ({
	id: "pm_1",
	brand: "visa",
	last4: "4242",
	expMonth: 7,
	expYear: 2030,
	isDefault: false,
	backupRank: null,
	...over,
});

const startUrl = window.location.href;

beforeEach(() => {
	resetReads();
	removeCard.mockReset();
	recordCardSaved.mockReset();
	recordCardSaved.mockResolvedValue({ ok: true, data: { ok: true } });
	toast.success.mockReset();
	toast.error.mockReset();
	toast.message.mockReset();
	reads.paymentMethods.mockResolvedValue([]);
});

afterEach(() => {
	window.history.replaceState(null, "", startUrl);
});

describe("readSetupReturn", () => {
	it("reads no return when Stripe's params are absent", () => {
		expect(readSetupReturn("?tab=billing")).toEqual({ kind: "none" });
	});

	it("reads a success with its SetupIntent", () => {
		expect(readSetupReturn("?setup_intent=seti_1&redirect_status=succeeded")).toEqual({
			kind: "succeeded",
			setupIntentId: "seti_1",
		});
	});

	it("reads processing", () => {
		expect(readSetupReturn("?setup_intent=seti_1&redirect_status=processing")).toEqual({
			kind: "processing",
		});
	});

	it("reads a failure, and an unknown status, as failed with the client secret", () => {
		const secret = "seti_1_secret_x";
		expect(
			readSetupReturn(`?setup_intent=seti_1&setup_intent_client_secret=${secret}&redirect_status=failed`),
		).toEqual({ kind: "failed", clientSecret: secret });
		expect(readSetupReturn("?setup_intent=seti_1&redirect_status=weird")).toEqual({
			kind: "failed",
			clientSecret: null,
		});
	});
});

describe("PaymentMethodsCard — 3-D Secure return", () => {
	it("a failed return says so, reopens the add-card dialog on the same SetupIntent, and strips the params", async () => {
		window.history.replaceState(
			null,
			"",
			"/acme/~/settings/billing?setup_intent=seti_1&setup_intent_client_secret=seti_1_secret_x&redirect_status=failed",
		);
		renderWithReads(<PaymentMethodsCard />);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(SETUP_FAILED_MESSAGE));
		expect(await screen.findByRole("dialog", { name: "Add payment method" })).toBeInTheDocument();
		expect(screen.getByTestId("stripe-elements")).toHaveAttribute(
			"data-client-secret",
			"seti_1_secret_x",
		);
		expect(window.location.search).toBe("");
		expect(recordCardSaved).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("a successful return records the save and says so", async () => {
		window.history.replaceState(
			null,
			"",
			"/acme/~/settings/billing?setup_intent=seti_1&redirect_status=succeeded",
		);
		renderWithReads(<PaymentMethodsCard />);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Card saved."));
		expect(recordCardSaved).toHaveBeenCalledWith({ setupIntentId: "seti_1" });
		expect(toast.error).not.toHaveBeenCalled();
		expect(window.location.search).toBe("");
	});
});

describe("PaymentMethodsCard — remove", () => {
	it("removes a card only after the confirmation, and closes it on success", async () => {
		reads.paymentMethods.mockResolvedValue([card({ id: "pm_default", isDefault: true }), card()]);
		removeCard.mockResolvedValue({ ok: true, data: { ok: true } });
		renderWithReads(<PaymentMethodsCard />);
		const buttons = await screen.findAllByRole("button", { name: "Remove" });
		fireEvent.click(buttons[1]);
		expect(removeCard).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Remove card" }));
		await waitFor(() => expect(removeCard).toHaveBeenCalledWith({ pmId: "pm_1" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Remove card" })).toBeNull());
	});

	it("a refused removal keeps the confirmation open beside the refusal", async () => {
		reads.paymentMethods.mockResolvedValue([card()]);
		removeCard.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "This card pays the current invoice." },
		});
		renderWithReads(<PaymentMethodsCard />);
		fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
		fireEvent.click(await screen.findByRole("button", { name: "Remove card" }));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("This card pays the current invoice."),
		);
		expect(screen.getByRole("button", { name: "Remove card" })).toBeInTheDocument();
	});
});
