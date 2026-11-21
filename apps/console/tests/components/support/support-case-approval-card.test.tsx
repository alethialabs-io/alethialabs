// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The assistant's proposed-case card:
//   - a failure that sent nothing (offline, session ended) returns the card to its buttons with
//     the reason, and is not reported to the model as final; any other failure is shown in place and
//     fed back, so the conversation can continue (G-02);
//   - a card drawn again from a recorded outcome shows that outcome and offers no second submit, so
//     a restored conversation cannot open the same case twice (G-10).

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionError } from "@/lib/actions/result";
import type { SupportCaseProposal } from "@/lib/ai/support/case";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

/** The failure the next `mutate` reports, or `null` for a success. */
const { next } = vi.hoisted(() => {
	const state: { failure: ActionError | null } = { failure: null };
	return { next: state };
});
vi.mock("@/components/support/use-submit-case", () => ({
	useSubmitCase: () => ({
		isPending: false,
		mutate: (
			_variables: unknown,
			callbacks: {
				onSuccess: (created: { id: string; caseNumber: number }) => void;
				onError: (failure: { error: ActionError }) => void;
			},
		) => {
			if (next.failure) callbacks.onError({ error: next.failure });
			else callbacks.onSuccess({ id: "8a7f8a0e-6f3b-4b8e-9c55-0d2e3f4a5b6c", caseNumber: 12 });
		},
	}),
}));

import {
	SupportCaseApprovalCard,
	cardStateFromOutput,
	isRetryableFailure,
} from "@/components/support/ask/support-case-approval-card";

const PROPOSAL: SupportCaseProposal = {
	id: "call-1",
	type: "billing",
	category: "billing_invoices",
	severity: "normal",
	subject: "Invoice shows the wrong amount",
	description: "The November invoice charges two seats twice.",
};

beforeEach(() => {
	next.failure = null;
});

describe("isRetryableFailure", () => {
	it("is true only for a failure that sent nothing", () => {
		expect(isRetryableFailure({ kind: "network", sent: false })).toBe(true);
		expect(isRetryableFailure({ kind: "unauthenticated" })).toBe(true);
		expect(isRetryableFailure({ kind: "network", sent: true })).toBe(false);
		expect(isRetryableFailure({ kind: "forbidden", message: "No." })).toBe(false);
	});
});

describe("cardStateFromOutput", () => {
	it("reads each recorded outcome, and nothing from a missing or malformed one", () => {
		expect(
			cardStateFromOutput({ status: "submitted", caseId: "8a7f8a0e-6f3b-4b8e-9c55-0d2e3f4a5b6c", caseNumber: 12 })
				.phase,
		).toBe("done");
		expect(cardStateFromOutput({ status: "failed", reason: "No." }).phase).toBe("denied");
		expect(cardStateFromOutput({ status: "dismissed" }).phase).toBe("rejected");
		expect(cardStateFromOutput(undefined).phase).toBe("idle");
		expect(cardStateFromOutput({ status: "maybe" }).phase).toBe("idle");
	});
});

describe("SupportCaseApprovalCard", () => {
	it("returns to its buttons after an offline failure and tells the model nothing yet (G-02)", () => {
		next.failure = { kind: "network", sent: false };
		const onResolve = vi.fn();
		render(<SupportCaseApprovalCard proposal={PROPOSAL} orgSlug="acme" onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /submit case/i }));
		expect(onResolve).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).not.toBe("");
		const retry = screen.getByRole("button", { name: /submit case/i });
		expect(retry.hasAttribute("disabled")).toBe(false);
	});

	it("shows a refusal in place and feeds it back, so the chat continues (G-02)", () => {
		next.failure = { kind: "forbidden", message: "You can't open cases in this organization." };
		const onResolve = vi.fn();
		render(<SupportCaseApprovalCard proposal={PROPOSAL} orgSlug="acme" onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /submit case/i }));
		expect(screen.getByText(/You can't open cases in this organization\./)).toBeTruthy();
		expect(onResolve).toHaveBeenCalledWith({
			status: "failed",
			reason: "You can't open cases in this organization.",
		});
		expect(screen.queryByRole("button", { name: /submit case/i })).toBeNull();
	});

	it("names the case by its reference once opened", () => {
		const onResolve = vi.fn();
		render(<SupportCaseApprovalCard proposal={PROPOSAL} orgSlug="acme" onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /submit case/i }));
		expect(screen.getByText("CASE-000012 opened.")).toBeTruthy();
		expect(screen.getByRole("button", { name: /view case/i })).toBeTruthy();
	});

	it("drawn again from a recorded submit, offers View case and no second submit (G-10)", () => {
		render(
			<SupportCaseApprovalCard
				proposal={PROPOSAL}
				orgSlug="acme"
				output={{ status: "submitted", caseId: "8a7f8a0e-6f3b-4b8e-9c55-0d2e3f4a5b6c", caseNumber: 12 }}
			/>,
		);
		expect(screen.queryByRole("button", { name: /submit case/i })).toBeNull();
		expect(screen.getByRole("button", { name: /view case/i })).toBeTruthy();
	});
});
