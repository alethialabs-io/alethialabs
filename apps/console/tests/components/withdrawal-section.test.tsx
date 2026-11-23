// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consumer withdrawal function in the billing settings (#7221).
//
// What is held here is what the law names and what the server decides:
//   · the control and its confirmation carry the CRD art. 11a labels, verbatim;
//   · the refund shown before acting is the server's figure, and the basis is the server's sentence;
//   · the withdrawal runs only after the confirmation step, and is called with no client clock;
//   · where the right does not exist (an organization's order, no order) nothing renders, and where
//     it existed and is over the section says why.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WithdrawalRight } from "@/app/server/actions/consumer-rights";

const getWithdrawalRight = vi.fn<() => Promise<WithdrawalRight>>();
const withdrawFromContract = vi.fn();
const toastError = vi.fn();

vi.mock("@/app/server/actions/consumer-rights", () => ({
	getWithdrawalRight: () => getWithdrawalRight(),
	withdrawFromContract: (...args: unknown[]) => withdrawFromContract(...args),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (select: (s: { fetchWorkspace: () => Promise<void> }) => unknown) =>
		select({ fetchWorkspace: async () => undefined }),
}));
vi.mock("@/lib/rpc/client", () => ({
	orpc: {
		billing: { summary: { key: () => ["summary"] }, planHistory: { key: () => ["history"] } },
		usage: { org: { key: () => ["usage"] } },
	},
}));
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

import { WithdrawalSection } from "@/components/billing/withdrawal-section";

const AVAILABLE: WithdrawalRight = {
	available: true,
	expiresAt: "2026-09-03T12:00:00.000Z",
	refundMinorUnits: 8_000,
	retainedMinorUnits: 4_000,
	currency: "eur",
	basis: "Immediate performance was requested and the proportional charge acknowledged, so the amount for 10 of 30 day(s) supplied is retained and the rest refunded.",
};

/** Renders the section in a fresh query client and returns the user driver. */
function renderSection(): ReturnType<typeof userEvent.setup> {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<WithdrawalSection />
		</QueryClientProvider>,
	);
	return userEvent.setup();
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("WithdrawalSection — an available right", () => {
	it("shows the server's refund, retained amount and basis before anything is done", async () => {
		getWithdrawalRight.mockResolvedValue(AVAILABLE);
		renderSection();
		expect(await screen.findByRole("button", { name: "Withdraw from contract here" })).toBeTruthy();
		expect(screen.getByText(/€80\.00/)).toBeTruthy();
		expect(screen.getByText(/€40\.00/)).toBeTruthy();
		expect(screen.getByText(AVAILABLE.basis ?? "")).toBeTruthy();
		expect(withdrawFromContract).not.toHaveBeenCalled();
	});

	it("withdraws only after 'Confirm withdrawal', with no client-supplied clock, and shows the recorded split", async () => {
		getWithdrawalRight.mockResolvedValue(AVAILABLE);
		withdrawFromContract.mockResolvedValue({
			refundMinorUnits: 8_000,
			retainedMinorUnits: 4_000,
			currency: "eur",
		});
		const user = renderSection();
		await user.click(await screen.findByRole("button", { name: "Withdraw from contract here" }));
		expect(withdrawFromContract).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
		await waitFor(() => expect(withdrawFromContract).toHaveBeenCalledTimes(1));
		expect(withdrawFromContract.mock.calls[0]).toEqual([{ reason: null }]);
		expect(await screen.findByTestId("withdrawal-recorded")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Withdraw from contract here" })).toBeNull();
	});

	it("keeps the confirmation open and names the email route when the withdrawal fails", async () => {
		getWithdrawalRight.mockResolvedValue(AVAILABLE);
		withdrawFromContract.mockRejectedValue(new Error("boom"));
		const user = renderSection();
		await user.click(await screen.findByRole("button", { name: "Withdraw from contract here" }));
		await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(String(toastError.mock.calls[0]?.[1]?.description)).toContain("legal@alethialabs.io");
		expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeTruthy();
		expect(screen.queryByTestId("withdrawal-recorded")).toBeNull();
	});
});

describe("WithdrawalSection — where the right is absent or over", () => {
	it.each(["not_a_consumer_order", "no_order"] as const)("renders nothing for %s", async (reason) => {
		getWithdrawalRight.mockResolvedValue({ available: false, reason });
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<WithdrawalSection />
			</QueryClientProvider>,
		);
		await waitFor(() => expect(getWithdrawalRight).toHaveBeenCalled());
		await waitFor(() => expect(container.textContent).toBe(""));
	});

	it("says the period ended rather than going silent", async () => {
		getWithdrawalRight.mockResolvedValue({
			available: false,
			reason: "period_expired",
			expiresAt: "2026-08-01T00:00:00.000Z",
		});
		renderSection();
		expect(await screen.findByText(/withdrawal period for this order ended/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Withdraw from contract here" })).toBeNull();
	});

	it("offers the email route when the position cannot be read", async () => {
		getWithdrawalRight.mockRejectedValue(new Error("down"));
		renderSection();
		expect(await screen.findByText("Couldn't load your withdrawal right")).toBeTruthy();
		expect(screen.getByRole("link", { name: "legal@alethialabs.io" })).toBeTruthy();
	});
});
