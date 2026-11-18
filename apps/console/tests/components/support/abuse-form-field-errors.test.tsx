// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The abuse report form announces a failed field the way the new-case wizard does (#6729): the
// control is `aria-invalid` and its `aria-describedby` names the message under it. Before this, the
// message rendered visually but the field read as valid, so a screen-reader user heard nothing.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/app/server/actions/support", () => ({ submitCase: vi.fn() }));
vi.mock("@/components/support/use-submit-case", () => ({
	useSubmitCase: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AbuseForm } from "@/components/support/abuse/abuse-form";

describe("~/support/abuse: a failed field is announced, not only drawn", () => {
	it("marks subject, description and email invalid and points each at its message", async () => {
		const { container } = render(<AbuseForm orgSlug="acme" defaultEmail="" />);
		const form = container.querySelector("form");
		if (!form) throw new Error("no form rendered");
		const email = container.querySelector<HTMLInputElement>("#abuse-email");
		if (email) fireEvent.change(email, { target: { value: "not-an-email" } });
		fireEvent.submit(form);

		for (const id of ["abuse-subject", "abuse-description", "abuse-email"]) {
			await waitFor(() => {
				const control = container.querySelector(`#${id}`);
				expect(control?.getAttribute("aria-invalid")).toBe("true");
				const describedBy = control?.getAttribute("aria-describedby") ?? "";
				const message = describedBy ? container.querySelector(`#${describedBy}`) : null;
				expect(message?.textContent?.trim()).not.toBe("");
			});
		}
	});

	it("leaves a pristine form unmarked", () => {
		const { container } = render(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" />);
		for (const id of ["abuse-subject", "abuse-description", "abuse-email"]) {
			expect(container.querySelector(`#${id}`)?.hasAttribute("aria-invalid")).toBe(false);
		}
	});
});
