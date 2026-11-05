// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the value editor renders from the fields it watches: Save follows the typed label, and the
// enforcement switch reveals the gates, whose "Require manual approval" in turn shows the minimum.
// The editor reads those fields through `useWatch` (not `form.watch()`), so these pin that every
// change to a watched field still re-renders the dialog.

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
	createValue: vi.fn(),
	updateValue: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ValueEditor } from "@/components/classification/value-editor";

/** Renders the create dialog, open. */
function renderEditor() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<ValueEditor dimensionId="d1" dimensionLabel="Environment" open onOpenChange={() => {}} />
		</QueryClientProvider>,
	);
}

describe("ValueEditor — watched fields drive the dialog", () => {
	it("enables Save only while the label has text", async () => {
		const user = userEvent.setup();
		renderEditor();
		const save = screen.getByRole("button", { name: /Save value/ });
		expect(save).toBeDisabled();

		const label = screen.getByLabelText("Label");
		await user.type(label, "Production");
		expect(save).toBeEnabled();

		await user.clear(label);
		expect(save).toBeDisabled();
	});

	it("shows the gates when enforcement is on, and the minimum only while approval is required", async () => {
		const user = userEvent.setup();
		renderEditor();
		expect(screen.queryByRole("switch", { name: "Require manual approval" })).toBeNull();

		await user.click(screen.getByRole("switch", { name: "Enforce promotion gates" }));
		const approval = screen.getByRole("switch", { name: "Require manual approval" });
		expect(screen.getByLabelText("Minimum approvals")).toBeInTheDocument();

		await user.click(approval);
		expect(screen.queryByLabelText("Minimum approvals")).toBeNull();
		expect(screen.getByRole("switch", { name: "Require verify pass" })).toBeInTheDocument();
	});
});
