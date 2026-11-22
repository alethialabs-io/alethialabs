// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The feedback dialog on the mutation contract (R6 G-27). It used to `await` the action inside a
// try/catch, so every failure was one sentence and a server validation message never reached its
// field; the rating was five buttons with no group name. The action is the mock; the dialog, the
// form and `useActionMutation` are real.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	submitFeedback: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("@/app/server/actions/feedback", () => ({ submitFeedback: h.submitFeedback }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { FEEDBACK_SENT_MESSAGE, FeedbackDialog } from "@/components/shell/feedback-dialog";

/** Renders the open dialog; returns its `onOpenChange` spy. */
function renderDialog(): ReturnType<typeof vi.fn> {
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<FeedbackDialog open onOpenChange={onOpenChange} />
		</QueryClientProvider>,
	);
	return onOpenChange;
}

beforeEach(() => {
	h.submitFeedback.mockReset();
	h.toastSuccess.mockReset();
	h.toastError.mockReset();
});

describe("FeedbackDialog — the rating", () => {
	it("is a named group of five named radios, one chosen at a time", async () => {
		renderDialog();
		const group = screen.getByRole("group", { name: "How was your experience?" });
		const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
		expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
			"Very unhappy",
			"Unhappy",
			"Neutral",
			"Happy",
			"Very happy",
		]);
		expect(screen.getByRole("radio", { name: "Very happy" })).toBeChecked();
		await userEvent.click(screen.getByRole("radio", { name: "Neutral" }));
		expect(screen.getByRole("radio", { name: "Neutral" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "Very happy" })).not.toBeChecked();
	});
});

describe("FeedbackDialog — sending", () => {
	it("sends once, toasts, and closes on success", async () => {
		let resolve: (value: unknown) => void = () => {};
		h.submitFeedback.mockImplementation(() => new Promise((r) => (resolve = r)));
		const onOpenChange = renderDialog();
		await userEvent.type(screen.getByLabelText("Message"), "The canvas is great");
		const send = screen.getByRole("button", { name: "Send" });
		await userEvent.click(send);
		await waitFor(() => expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled());
		await userEvent.click(screen.getByRole("button", { name: "Sending…" }));
		expect(h.submitFeedback).toHaveBeenCalledTimes(1);
		expect(h.submitFeedback.mock.calls[0]?.[0]).toEqual({
			topic: "idea",
			rating: 5,
			message: "The canvas is great",
		});
		resolve({ ok: true, data: null });
		await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith(FEEDBACK_SENT_MESSAGE));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("puts a server validation message under its field, with no toast, and stays open", async () => {
		h.submitFeedback.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Too long", fields: { message: ["Too long"] } },
		});
		const onOpenChange = renderDialog();
		await userEvent.type(screen.getByLabelText("Message"), "x");
		await userEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText("Too long")).toBeInTheDocument();
		expect(h.toastError).not.toHaveBeenCalled();
		expect(h.toastSuccess).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("an empty message is refused in the form and never sent", async () => {
		renderDialog();
		await userEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText("Tell us a little more")).toBeInTheDocument();
		expect(h.submitFeedback).not.toHaveBeenCalled();
	});
});
