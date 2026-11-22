// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the dimension editor. Create follows the label it watches, and opening on a template
// seeds both the form (the template's fields) and the sheet's own state (its values, staged). The
// open-time reset is split in two: the sheet's state during render and the form in an effect. These
// pin that both halves still land on the same open.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("@/app/server/actions/classification/dimensions", () => ({
	createDimension: vi.fn(),
	createDimensionWithValues: vi.fn(),
	updateDimension: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { createDimensionWithValues } from "@/app/server/actions/classification/dimensions";
import { DimensionEditorSheet } from "@/components/classification/dimension-editor-sheet";

/** Renders the sheet open in create mode, optionally on a template. */
function renderSheet(initialTemplateKey?: string) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<DimensionEditorSheet open onOpenChange={() => {}} initialTemplateKey={initialTemplateKey} />
		</QueryClientProvider>,
	);
}

describe("DimensionEditorSheet", () => {
	it("enables Create only once the label has text", async () => {
		const user = userEvent.setup();
		renderSheet();
		const create = screen.getByRole("button", { name: /Create dimension/ });
		expect(create).toBeDisabled();

		await user.type(screen.getByLabelText("Label"), "Team");
		expect(create).toBeEnabled();
	});

	it("opening on a template seeds its label and stages its values", async () => {
		renderSheet("environment");
		expect(await screen.findByDisplayValue("Environment")).toBeInTheDocument();
		expect(screen.getByText("3 staged")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Create dimension/ })).toBeEnabled();
	});

	// #6825 (F-13): a validation message about anything the sheet has no field for used to be
	// dropped, so Save did nothing. The template create names its fields `dimension.*` and
	// `values.N.*`; each must reach the reader.
	it("puts a template create's dimension message under its field and a staged value's in the root error", async () => {
		vi.mocked(createDimensionWithValues).mockResolvedValueOnce({
			ok: false,
			error: {
				kind: "validation",
				message: "Check the highlighted fields.",
				fields: {
					"dimension.key": ["Another dimension already uses this key."],
					"values.1.value": ["Use lowercase letters, numbers, and single - or _ separators."],
				},
			},
		});
		const user = userEvent.setup();
		renderSheet("environment");
		await screen.findByDisplayValue("Environment");
		await user.click(screen.getByRole("button", { name: /Create dimension/ }));

		expect(await screen.findByText("Another dimension already uses this key.")).toBeInTheDocument();
		const root = await screen.findByRole("alert");
		// The template's second staged value is "Staging": the message names it.
		expect(
			within(root).getByText(
				"“Staging”: Use lowercase letters, numbers, and single - or _ separators.",
			),
		).toBeInTheDocument();
	});

	it("refuses to stage a value with no letter or number, and says why", async () => {
		const user = userEvent.setup();
		renderSheet();
		const box = screen.getByLabelText("New value label");
		await user.type(box, "!!!{Enter}");

		expect(screen.getByRole("alert")).toHaveTextContent(
			"A value needs at least one letter or number.",
		);
		expect(screen.getByText("add now or after")).toBeInTheDocument();

		await user.type(box, "a");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// F-15: a template picked (the form is RESET to its fields, so the form alone reads pristine) and
	// values staged are work too — closing asks before dropping them.
	describe("dirty tracking covers the template and the staged values (F-15)", () => {
		/** Renders the sheet open in create mode with a spy on `onOpenChange`. */
		function renderWithSpy() {
			const onOpenChange = vi.fn();
			const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			render(
				<QueryClientProvider client={qc}>
					<DimensionEditorSheet open onOpenChange={onOpenChange} />
				</QueryClientProvider>,
			);
			return onOpenChange;
		}

		it("a pristine sheet closes without asking", async () => {
			const user = userEvent.setup();
			const onOpenChange = renderWithSpy();
			await user.click(screen.getByRole("button", { name: "Cancel" }));
			expect(onOpenChange).toHaveBeenCalledWith(false);
			expect(screen.queryByText("Discard your changes?")).toBeNull();
		});

		it("picking a template makes Cancel ask first", async () => {
			const user = userEvent.setup();
			const onOpenChange = renderWithSpy();
			// "Environment" is also an "Applies to" kind, so the template is found inside its group.
			const templates = screen.getByRole("group", { name: "Start from a template" });
			await user.click(within(templates).getByRole("button", { name: "Environment" }));
			await user.click(screen.getByRole("button", { name: "Cancel" }));
			expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
			expect(onOpenChange).not.toHaveBeenCalled();
		});

		it("a staged value alone makes Cancel ask first", async () => {
			const user = userEvent.setup();
			const onOpenChange = renderWithSpy();
			await user.type(screen.getByLabelText("New value label"), "Blue{Enter}");
			expect(screen.getByText("1 staged")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Cancel" }));
			expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
			expect(onOpenChange).not.toHaveBeenCalled();
		});
	});
});
