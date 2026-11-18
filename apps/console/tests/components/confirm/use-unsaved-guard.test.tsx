// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6761 — one discard question for a sheet that is closed and for a row that is left.
//
// The guard is asserted from both of its sources (a form, and a boolean the caller computes), and
// in both directions: with nothing unsaved the person leaves at once and is never asked, and with
// something unsaved leaving waits for the answer. The pristine cases matter as much as the dirty
// ones — without them every assertion would also pass against a guard that always asked.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { DiscardPrompt, useUnsavedGuard } from "@/components/confirm/use-unsaved-guard";

/** A one-field form whose Close goes through the guard. */
function FormHarness({ onLeave }: { onLeave: () => void }) {
	const form = useForm<{ name: string }>({ defaultValues: { name: "" } });
	const unsaved = useUnsavedGuard(form);
	return (
		<>
			<label>
				Name
				<input {...form.register("name")} />
			</label>
			<button type="button" onClick={() => unsaved.guard(onLeave)}>
				Close
			</button>
			<DiscardPrompt
				{...unsaved.prompt}
				title="Discard your changes?"
				description="What you entered has not been saved."
				confirmLabel="Discard changes"
			/>
		</>
	);
}

/** A row switch guarded by a boolean the caller already has. */
function FlagHarness({ dirty, onLeave }: { dirty: boolean; onLeave: () => void }) {
	const unsaved = useUnsavedGuard(dirty);
	return (
		<>
			<button type="button" onClick={() => unsaved.guard(onLeave)}>
				Open another row
			</button>
			<DiscardPrompt
				{...unsaved.prompt}
				title="Discard unsaved changes?"
				description="Opening another row discards them."
				confirmLabel="Discard changes"
			/>
		</>
	);
}

describe("useUnsavedGuard over a form", () => {
	it("leaves at once when nothing was typed", async () => {
		const user = userEvent.setup();
		const onLeave = vi.fn();
		render(<FormHarness onLeave={onLeave} />);

		await user.click(screen.getByRole("button", { name: "Close" }));

		expect(onLeave).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("Discard your changes?")).toBeNull();
	});

	it("asks first when something was typed, and Cancel keeps it", async () => {
		const user = userEvent.setup();
		const onLeave = vi.fn();
		render(<FormHarness onLeave={onLeave} />);

		await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
		await user.click(screen.getByRole("button", { name: "Close" }));

		expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
		expect(onLeave).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.queryByText("Discard your changes?")).toBeNull());
		expect(onLeave).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("ops");
	});

	it("leaves once when the person chooses to discard", async () => {
		const user = userEvent.setup();
		const onLeave = vi.fn();
		render(<FormHarness onLeave={onLeave} />);

		await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.click(await screen.findByRole("button", { name: "Discard changes" }));

		expect(onLeave).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByText("Discard your changes?")).toBeNull());
	});
});

describe("useUnsavedGuard over a boolean", () => {
	it("leaves at once while the flag is false", async () => {
		const user = userEvent.setup();
		const onLeave = vi.fn();
		render(<FlagHarness dirty={false} onLeave={onLeave} />);

		await user.click(screen.getByRole("button", { name: "Open another row" }));

		expect(onLeave).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
	});

	it("asks first while the flag is true, and discarding leaves", async () => {
		const user = userEvent.setup();
		const onLeave = vi.fn();
		render(<FlagHarness dirty onLeave={onLeave} />);

		await user.click(screen.getByRole("button", { name: "Open another row" }));

		expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
		expect(onLeave).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));

		expect(onLeave).toHaveBeenCalledTimes(1);
	});
});

describe("DiscardPrompt", () => {
	it("reports a discard as a discard, never also as keep", async () => {
		const user = userEvent.setup();
		const onKeep = vi.fn();
		const onDiscard = vi.fn();
		render(
			<DiscardPrompt
				open
				onKeep={onKeep}
				onDiscard={onDiscard}
				title="Discard unsaved changes?"
				description="Opening another row discards them."
				confirmLabel="Discard changes"
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		expect(onDiscard).toHaveBeenCalledTimes(1);
		expect(onKeep).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onKeep).toHaveBeenCalledTimes(1);
		expect(onDiscard).toHaveBeenCalledTimes(1);
	});
});
