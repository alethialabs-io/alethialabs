// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6755: `FormRootError` shows the server messages that belong to no field, and nothing otherwise.

import { act, render, screen } from "@testing-library/react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { FormRootError } from "@/components/forms/form-root-error";
import { applyFieldErrors } from "@/lib/actions/form-errors";

interface Values {
	name: string;
}

const KNOWN = ["name"] as const;

/** A form that renders only its root error, and hands the form instance to the test. */
function Harness({ expose }: { expose: (form: UseFormReturn<Values>) => void }) {
	const form = useForm<Values>({ defaultValues: { name: "" } });
	expose(form);
	return <FormRootError form={form} />;
}

/** Renders the harness and returns the form it created. */
function renderHarness(): UseFormReturn<Values> {
	const forms: UseFormReturn<Values>[] = [];
	render(<Harness expose={(form) => forms.push(form)} />);
	const form = forms[0];
	if (!form) throw new Error("the harness did not render");
	return form;
}

describe("FormRootError", () => {
	it("renders nothing while the form has no root server error", () => {
		renderHarness();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows a message that no field could take", () => {
		const form = renderHarness();
		act(() => {
			applyFieldErrors(form, { region: ["Pick a region."] }, KNOWN);
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Pick a region.");
	});

	it("stays empty when every message went under a field", () => {
		const form = renderHarness();
		act(() => {
			applyFieldErrors(form, { name: ["Name is required."] }, KNOWN);
		});
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("goes away when the root error is cleared", () => {
		const form = renderHarness();
		act(() => {
			applyFieldErrors(form, { region: ["Pick a region."] }, KNOWN);
		});
		expect(screen.getByRole("alert")).toBeInTheDocument();
		act(() => form.clearErrors("root.server"));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
