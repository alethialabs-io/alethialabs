// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the dimension editor. Create follows the label it watches, and opening on a template
// seeds both the form (the template's fields) and the sheet's own state (its values, staged). The
// open-time reset is split in two: the sheet's state during render and the form in an effect. These
// pin that both halves still land on the same open.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
});
