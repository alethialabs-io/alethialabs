// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6755: `applyFieldErrors` puts a server message under the field it is about and everything else
// in the form's root error, so no validation message is dropped.

import { act, renderHook } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { applyFieldErrors } from "@/lib/actions/form-errors";
import type { FieldErrors } from "@/lib/actions/result";

interface Values {
	name: string;
	slug: string;
}

const KNOWN = ["name", "slug"] as const;

/** Renders a form, applies `fields` to it, and returns the outcome and the form's errors. */
function apply(fields: FieldErrors) {
	const { result } = renderHook(() => {
		const form = useForm<Values>({ defaultValues: { name: "", slug: "" } });
		return { form, errors: form.formState.errors };
	});
	let outcome = { unmapped: [""] };
	act(() => {
		outcome = applyFieldErrors(result.current.form, fields, KNOWN);
	});
	return { outcome, errors: () => result.current.errors };
}

describe("applyFieldErrors", () => {
	it("puts the first message of a known field under that field", () => {
		const { outcome, errors } = apply({ slug: ["That slug is taken.", "Second message."] });
		expect(errors().slug?.message).toBe("That slug is taken.");
		expect(errors().slug?.type).toBe("server");
		expect(errors().root).toBeUndefined();
		expect(outcome.unmapped).toEqual([]);
	});

	it("puts messages for keys the form does not render in the root error and names the keys", () => {
		const { outcome, errors } = apply({
			name: ["Name is required."],
			_form: ["The request was incomplete."],
			region: ["Pick a region."],
		});
		expect(errors().name?.message).toBe("Name is required.");
		expect(errors().root?.server?.message).toBe("The request was incomplete. Pick a region.");
		expect(outcome.unmapped).toEqual(["_form", "region"]);
	});

	it("skips a key with no message and sets nothing when there is nothing to show", () => {
		const { outcome, errors } = apply({ name: undefined, slug: [] });
		expect(errors().name).toBeUndefined();
		expect(errors().slug).toBeUndefined();
		expect(errors().root).toBeUndefined();
		expect(outcome.unmapped).toEqual([]);
	});
});
