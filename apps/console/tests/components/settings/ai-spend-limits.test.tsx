// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// F047 (#6127): the AI spend-limit form. The console hunt typed -5 and 1e20 and pressed Save: nothing
// happened — no inline error, no toast, and the value silently not persisted — and a VALID save gave
// no confirmation. This drives the real form (react-hook-form over the shared zod schema) and the
// real `useActionMutation`; only the server action, the toast and the router are stand-ins.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/actions/result";
import type { AiSpendLimits as Limits } from "@/components/settings/usage/spend-limits";

const { saveAiSpendLimits, toast } = vi.hoisted(() => ({
	saveAiSpendLimits: vi.fn<(raw: Limits) => Promise<ActionResult<Limits>>>(),
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/server/actions/billing", () => ({ saveAiSpendLimits }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./billing-rpc-fake")).fakeOrpc }));

import { AiSpendLimits } from "@/components/settings/usage/ai-spend-limits";

/** The form under a fresh query client, seeded with no limits. */
function renderForm(org: number | null = null, perUser: number | null = null) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<AiSpendLimits orgWeeklyCapCredits={org} perUserWeeklyCapCredits={perUser} />
		</QueryClientProvider>,
	);
	return client;
}

/** Types into a labelled field. */
function type(label: string, value: string) {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Presses Save once the form has registered the edit (Save is disabled on a pristine form). */
async function save() {
	const button = screen.getByRole("button", { name: /save limits|saving/i });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
}

beforeEach(() => {
	saveAiSpendLimits.mockReset();
	toast.success.mockReset();
	toast.error.mockReset();
});

describe("AI spend limits (F047)", () => {
	it("says a negative limit is invalid, inline, and sends nothing", async () => {
		renderForm();
		type("Whole org / week", "-5");
		await save();
		expect(await screen.findByText("A limit can't be negative.")).toBeInTheDocument();
		expect(screen.getByLabelText("Whole org / week")).toHaveAttribute("aria-invalid", "true");
		expect(saveAiSpendLimits).not.toHaveBeenCalled();
	});

	it("refuses exponent notation and an amount over the ceiling, inline", async () => {
		renderForm();
		type("Whole org / week", "1e20");
		type("Per member / week", "20000");
		await save();
		expect(await screen.findByText(/Enter an amount in dollars/)).toBeInTheDocument();
		expect(screen.getByText(/A limit can be at most \$10,000\.00 a week\./)).toBeInTheDocument();
		expect(saveAiSpendLimits).not.toHaveBeenCalled();
	});

	it("saves a valid limit in CREDITS, clears a blank one, and confirms the save", async () => {
		saveAiSpendLimits.mockImplementation(async (raw) => ({ ok: true, data: raw }));
		renderForm(null, 5_000);
		type("Whole org / week", "12.50");
		type("Per member / week", "");
		await save();
		await waitFor(() =>
			expect(saveAiSpendLimits).toHaveBeenCalledWith({
				orgWeeklyCapCredits: 12_500,
				perUserWeeklyCapCredits: null,
			}),
		);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Spend limits saved."));
	});

	it("disables Save while the save is in flight (the double-submit guard)", async () => {
		saveAiSpendLimits.mockImplementation(() => new Promise(() => {}));
		renderForm();
		type("Whole org / week", "50");
		await save();
		await waitFor(() => expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: /saving/i }));
		expect(saveAiSpendLimits).toHaveBeenCalledTimes(1);
	});

	it("puts the server's field error on the field it names", async () => {
		saveAiSpendLimits.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "A limit can't be negative.",
				fields: { perUserWeeklyCapCredits: ["Server says no."] },
			},
		});
		renderForm();
		type("Per member / week", "50");
		await save();
		expect(await screen.findByText("Server says no.")).toBeInTheDocument();
		expect(screen.getByLabelText("Per member / week")).toHaveAttribute("aria-invalid", "true");
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("a refusal is a toast with the server's sentence, not silence", async () => {
		saveAiSpendLimits.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "This organization has no billing account yet." },
		});
		renderForm();
		type("Whole org / week", "50");
		await save();
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("This organization has no billing account yet."),
		);
	});

	it("saves $0 as a limit of 0 credits — not as 'no limit' — and says what 0 does", async () => {
		saveAiSpendLimits.mockImplementation(async (raw) => ({ ok: true, data: raw }));
		renderForm();
		expect(screen.getByText(/\$0\s+pauses the plan's included AI/)).toBeInTheDocument();
		type("Whole org / week", "0");
		await save();
		await waitFor(() =>
			expect(saveAiSpendLimits).toHaveBeenCalledWith({
				orgWeeklyCapCredits: 0,
				perUserWeeklyCapCredits: null,
			}),
		);
	});

	it("shows a finer stored limit rounded to the cent, which the form can save back", () => {
		renderForm(12_345, null);
		expect(screen.getByLabelText("Whole org / week")).toHaveValue("12.35");
	});

	it("keeps Save disabled until something changed", () => {
		renderForm(50_000, null);
		expect(screen.getByLabelText("Whole org / week")).toHaveValue("50");
		expect(screen.getByRole("button", { name: /save limits/i })).toBeDisabled();
	});
});
