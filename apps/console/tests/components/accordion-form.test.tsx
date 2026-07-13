// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Behavioral test for the AccordionForm section machine: Continue on an invalid section stays
// open, Continue on a valid one closes it and opens the next incomplete section, the collapsed
// summary reflects live values, and onComplete fires after the last section advances.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	AccordionForm,
	type FormSectionDef,
} from "@/components/forms/accordion-form";

const schema = z.object({
	name: z.string().min(1, "Name required"),
	email: z.string().email("Bad email"),
});
type Values = z.infer<typeof schema>;

/** A two-section form (no terminal section) so advancing off the last section fires onComplete. */
function Harness({ onComplete }: { onComplete?: () => void }) {
	const [open, setOpen] = useState("identity");
	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: { name: "", email: "" },
		mode: "onChange",
	});
	const sections: FormSectionDef<Values>[] = [
		{
			id: "identity",
			title: "Identity",
			fields: ["name"],
			summary: (v) => v.name,
			body: () => (
				<input
					aria-label="name"
					value={form.watch("name")}
					onChange={(e) =>
						form.setValue("name", e.target.value, { shouldValidate: true })
					}
				/>
			),
		},
		{
			id: "contact",
			title: "Contact",
			fields: ["email"],
			summary: (v) => v.email,
			body: () => (
				<input
					aria-label="email"
					value={form.watch("email")}
					onChange={(e) =>
						form.setValue("email", e.target.value, { shouldValidate: true })
					}
				/>
			),
		},
	];
	return (
		<FormProvider {...form}>
			<AccordionForm
				sections={sections}
				open={open}
				onOpenChange={setOpen}
				onComplete={onComplete}
			/>
		</FormProvider>
	);
}

describe("AccordionForm", () => {
	it("keeps the section open when Continue fails validation", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		// identity is open → its body input is mounted; contact's is not.
		expect(screen.getByLabelText("name")).toBeTruthy();
		expect(screen.queryByLabelText("email")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Continue" }));

		// name is empty → invalid → still open (did not advance to contact).
		expect(screen.getByLabelText("name")).toBeTruthy();
		expect(screen.queryByLabelText("email")).toBeNull();
	});

	it("advances to the next section when Continue passes", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.type(screen.getByLabelText("name"), "Alice");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		// identity closed (its input unmounted), contact opened.
		expect(screen.queryByLabelText("name")).toBeNull();
		expect(screen.getByLabelText("email")).toBeTruthy();
	});

	it("renders the collapsed summary from live values", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.type(screen.getByLabelText("name"), "Alice");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		// identity is now collapsed; its trigger shows the summary (the entered name).
		expect(screen.getByText("Alice")).toBeTruthy();
	});

	it("fires onComplete after the last section advances", async () => {
		const onComplete = vi.fn();
		const user = userEvent.setup();
		render(<Harness onComplete={onComplete} />);

		await user.type(screen.getByLabelText("name"), "Alice");
		await user.click(screen.getByRole("button", { name: "Continue" }));
		await user.type(screen.getByLabelText("email"), "alice@example.com");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(onComplete).toHaveBeenCalledOnce();
		// every section collapsed → no body inputs mounted.
		expect(screen.queryByLabelText("name")).toBeNull();
		expect(screen.queryByLabelText("email")).toBeNull();
	});
});
