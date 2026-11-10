// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the duplicate dialog renders from the account and region it watches: the region picker
// asks for an account until one is chosen, and Duplicate stays disabled until both are set. The
// dialog reads those two fields through `useWatch`, so this pins that choosing an account still
// re-renders the dialog.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("@/app/server/actions/projects", () => ({ tryDuplicateProjectForProvider: vi.fn() }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DuplicateProjectDialog } from "@/components/projects/duplicate-project-dialog";

h.handlers["projects.duplicateTargets"] = async () => ({
	provider: "aws",
	projectName: "Shop",
	categories: [],
	suggestedNames: {
		aws: "Shop (aws)",
		gcp: "Shop (gcp)",
		azure: "Shop (azure)",
		hetzner: "Shop (hetzner)",
		alibaba: "Shop (alibaba)",
	},
	identities: [{ id: "gcp-1", name: "GCP prod", displayId: "proj-1", provider: "gcp" }],
});

describe("DuplicateProjectDialog — watched account and region", () => {
	it("asks for an account first, then offers regions; Duplicate waits for both", async () => {
		const user = userEvent.setup();
		render(
			<DuplicateProjectDialog
				open
				onOpenChange={() => {}}
				sourceProjectId="p1"
				sourceProjectName="Shop"
				orgSlug="acme"
			/>,
			{ wrapper: queryWrapper() },
		);
		const duplicate = screen.getByRole("button", { name: "Duplicate" });
		expect(duplicate).toBeDisabled();
		expect(screen.getByText("Select an account first")).toBeInTheDocument();

		// The account picker replaces "Loading accounts…" once the read lands.
		await screen.findByText("Select cloud account");
		const [account] = screen.getAllByRole("combobox");
		await user.click(account);
		await user.click(await screen.findByRole("option", { name: /GCP prod/ }));

		expect(await screen.findByText("Select region")).toBeInTheDocument();
		expect(screen.queryByText("Select an account first")).toBeNull();
		expect(duplicate).toBeDisabled();
	});
});
