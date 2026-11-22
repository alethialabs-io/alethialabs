// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The abuse report form, on the wizard engine as a one-step wizard:
//   - a failed field is announced the way the new-case wizard does it (#6729): the control is
//     `aria-invalid` and its `aria-describedby` names the message under it;
//   - a server field refusal lands under the field it names, and one that names no field on the
//     page is shown above the button instead of nowhere (G-04);
//   - what was typed survives the page going away and coming back, for the same viewer, with a
//     way to start over (G-07);
//   - a report that passes is filed once, as an abuse case with its fixed fields and the context.

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldErrors } from "@/lib/actions/result";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/app/server/actions/support", () => ({ submitCase: vi.fn() }));

/** What the form handed `useSubmitCase`, and the `submit` it was given back. */
const { submitSpy, captured } = vi.hoisted(() => {
	const handlers: { onValidationError: ((fields: FieldErrors) => void) | null } = {
		onValidationError: null,
	};
	return {
		submitSpy: vi.fn<(variables: { values: Record<string, unknown> }) => void>(),
		captured: handlers,
	};
});
vi.mock("@/components/support/use-submit-case", () => ({
	useSubmitCase: (_org: string, opts: { onValidationError?: (fields: FieldErrors) => void }) => {
		captured.onValidationError = opts.onValidationError ?? null;
		return { mutate: vi.fn(), submit: submitSpy, isPending: false, isSuccess: false };
	},
}));

import { AbuseForm } from "@/components/support/abuse/abuse-form";

/** Renders the form and lets the engine finish booting (reading its draft). */
async function renderReady(ui: ReactElement) {
	const view = render(ui);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return view;
}

/** The control with `id`, which must exist. */
function control(container: HTMLElement, id: string): HTMLInputElement {
	const el = container.querySelector<HTMLInputElement>(`#${id}`);
	if (!el) throw new Error(`no #${id}`);
	return el;
}

/** The text of the message `aria-describedby` points the control with `id` at. */
function messageFor(container: HTMLElement, id: string): string {
	const describedBy = control(container, id).getAttribute("aria-describedby") ?? "";
	return describedBy ? (container.querySelector(`#${describedBy}`)?.textContent?.trim() ?? "") : "";
}

/** The page's form, which must exist. */
function formOf(container: HTMLElement): HTMLFormElement {
	const form = container.querySelector("form");
	if (!form) throw new Error("no form rendered");
	return form;
}

beforeEach(() => {
	sessionStorage.clear();
	submitSpy.mockReset();
	captured.onValidationError = null;
});

describe("~/support/abuse: a failed field is announced, not only drawn", () => {
	it("marks subject, description and email invalid and points each at its message", async () => {
		const { container } = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="" />);
		fireEvent.change(control(container, "abuse-email"), { target: { value: "not-an-email" } });
		fireEvent.submit(formOf(container));

		for (const id of ["abuse-subject", "abuse-description", "abuse-email"]) {
			await waitFor(() => {
				expect(control(container, id).getAttribute("aria-invalid")).toBe("true");
				expect(messageFor(container, id)).not.toBe("");
			});
		}
		expect(submitSpy).not.toHaveBeenCalled();
	});

	it("leaves a pristine form unmarked", async () => {
		const { container } = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" />);
		for (const id of ["abuse-subject", "abuse-description", "abuse-email"]) {
			expect(control(container, id).hasAttribute("aria-invalid")).toBe(false);
		}
	});
});

describe("~/support/abuse: server refusals are shown where they belong (G-04)", () => {
	it("puts a refusal on a field under that field", async () => {
		const { container } = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" />);
		act(() => captured.onValidationError?.({ subject: ["That subject is not allowed."] }));
		await waitFor(() => expect(messageFor(container, "abuse-subject")).toBe("That subject is not allowed."));
	});

	it("shows a refusal on a field the page does not render above the button", async () => {
		const { container } = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" />);
		act(() => captured.onValidationError?.({ type: ["Abuse reports are closed right now."] }));
		await waitFor(() =>
			expect(container.querySelector('[data-slot="wizard-form-error"]')?.textContent).toBe(
				"Abuse reports are closed right now.",
			),
		);
	});
});

describe("~/support/abuse: a valid report is filed once, as an abuse case", () => {
	it("adds the fixed fields and the context, and sends what was typed", async () => {
		const { container } = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" />);
		fireEvent.change(control(container, "abuse-subject"), { target: { value: "Phishing page" } });
		fireEvent.change(control(container, "abuse-description"), {
			target: { value: "A page imitating our sign-in form." },
		});
		fireEvent.submit(formOf(container));
		await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
		expect(submitSpy.mock.calls[0]?.[0].values).toMatchObject({
			type: "abuse",
			category: "other",
			severity: "high",
			subject: "Phishing page",
			description: "A page imitating our sign-in form.",
			contact: { notifyEmail: "a@example.test", channel: "email" },
			abuse: { reporterRelationship: "affected_party" },
			context: { consoleUrl: expect.any(String), userAgent: expect.any(String) },
		});
	});
});

describe("~/support/abuse: what was typed survives leaving the page (G-07)", () => {
	it("restores the report for the same viewer, and Start over clears it", async () => {
		const first = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" viewerId="u1" />);
		fireEvent.change(control(first.container, "abuse-subject"), { target: { value: "Spam from a cluster" } });
		// Leaving the page writes a pending draft at once.
		first.unmount();

		const second = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" viewerId="u1" />);
		await waitFor(() => expect(control(second.container, "abuse-subject").value).toBe("Spam from a cluster"));
		const notice = second.container.querySelector('[data-slot="wizard-restored-notice"]');
		expect(notice?.textContent).toContain("Restored your draft");

		const startOver = notice?.querySelector("button");
		if (!startOver) throw new Error("no Start over");
		fireEvent.click(startOver);
		await waitFor(() => expect(control(second.container, "abuse-subject").value).toBe(""));
		expect(second.container.querySelector('[data-slot="wizard-restored-notice"]')).toBeNull();
	});

	it("does not show one viewer's report to another", async () => {
		const first = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="" viewerId="u1" />);
		fireEvent.change(control(first.container, "abuse-subject"), { target: { value: "Mine" } });
		first.unmount();

		const other = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="" viewerId="u2" />);
		expect(control(other.container, "abuse-subject").value).toBe("");
		expect(other.container.querySelector('[data-slot="wizard-restored-notice"]')).toBeNull();
	});

	it("keeps nothing without a viewer", async () => {
		const first = await renderReady(<AbuseForm orgSlug="acme" defaultEmail="" />);
		fireEvent.change(control(first.container, "abuse-subject"), { target: { value: "Anonymous" } });
		first.unmount();
		expect(sessionStorage.length).toBe(0);
	});
});
