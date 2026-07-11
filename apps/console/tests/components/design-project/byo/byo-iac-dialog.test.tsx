// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component tests for the BYO IaC attach dialog: the four-step wizard advances only when the step's
// fields validate (scalar-only var rows: empty/duplicate names block), and Review calls
// attachIacSource with the collected repo/path/ref + folded scalar var_values. The heavy
// RepositorySelector (git-provider auth + server fetch) is stubbed to a plain input so the wizard is
// tested in isolation.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ByoIacDialog } from "@/components/design-project/byo/byo-iac-dialog";

const { attachIacSource } = vi.hoisted(() => ({ attachIacSource: vi.fn() }));
vi.mock("@/app/server/actions/byo-iac", () => ({
	attachIacSource: (input: unknown) => attachIacSource(input),
}));

// Stub the git-provider selector to a plain input — its auth/fetch internals aren't under test.
vi.mock("@/components/repository-selector", () => ({
	RepositorySelector: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (v: string) => void;
	}) => (
		<input
			aria-label="Module repository"
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	),
}));

const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
	attachIacSource.mockReset();
	attachIacSource.mockResolvedValue({ ok: true, id: "src-1" });
	toast.success.mockReset();
	toast.error.mockReset();
});

/** Renders the dialog open, in edit mode. */
function renderDialog() {
	return render(
		<ByoIacDialog
			open
			onOpenChange={() => {}}
			projectId="proj-1"
			environmentId="env-1"
			onAttached={vi.fn()}
		/>,
	);
}

/** Advances the wizard from Repository → Path & ref by entering a repo URL. */
async function toPathStep(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("Module repository"), "https://github.com/acme/infra-tofu");
	await user.click(screen.getByRole("button", { name: /next/i }));
}

describe("ByoIacDialog", () => {
	it("blocks advancing past Repository without a valid repo URL", async () => {
		const user = userEvent.setup();
		renderDialog();
		// No URL yet → still on the Repository step.
		await user.click(screen.getByRole("button", { name: /next/i }));
		expect(screen.getByLabelText("Module repository")).toBeInTheDocument();
		expect(await screen.findByText(/valid git repository url/i)).toBeInTheDocument();
	});

	it("validates scalar var rows — an empty variable name blocks the Variables step", async () => {
		const user = userEvent.setup();
		renderDialog();
		await toPathStep(user);
		// Path & ref → Variables.
		await user.click(screen.getByRole("button", { name: /next/i }));
		// Add a row but leave the name empty, then try to advance.
		await user.click(screen.getByRole("button", { name: /add/i }));
		await user.click(screen.getByRole("button", { name: /next/i }));
		expect(await screen.findByText(/variable name is required/i)).toBeInTheDocument();
		// Still on Variables (Review's summary text absent).
		expect(screen.queryByText(/replace mode · scan on attach/i)).not.toBeInTheDocument();
	});

	it("attaches with the collected coords + folded scalar var_values on Review", async () => {
		const user = userEvent.setup();
		renderDialog();
		await toPathStep(user);
		// Path & ref: set a root-module path.
		await user.type(screen.getByLabelText(/root-module path/i), "infra/prod");
		await user.click(screen.getByRole("button", { name: /next/i }));
		// Variables: add one valid string var (default kind = string).
		await user.click(screen.getByRole("button", { name: /add/i }));
		await user.type(screen.getByLabelText(/variable 1 name/i), "region");
		await user.type(screen.getByLabelText(/variable 1 value/i), "us-east-1");
		await user.click(screen.getByRole("button", { name: /next/i }));
		// Review → submit.
		expect(await screen.findByText(/replace mode · scan on attach/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /attach source/i }));
		await waitFor(() => expect(attachIacSource).toHaveBeenCalledTimes(1));
		expect(attachIacSource).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				environmentId: "env-1",
				repoUrl: "https://github.com/acme/infra-tofu",
				path: "infra/prod",
				varValues: { region: "us-east-1" },
			}),
		);
		expect(toast.success).toHaveBeenCalled();
	});

	it("shows the module coords on the Review step", async () => {
		const user = userEvent.setup();
		renderDialog();
		await toPathStep(user);
		await user.click(screen.getByRole("button", { name: /next/i })); // → Variables
		await user.click(screen.getByRole("button", { name: /next/i })); // → Review
		const review = await screen.findByText(/github\.com\/acme\/infra-tofu/i);
		// Coords render inside the review summary block (repo line + path/ref line + count line).
		const summary = review.parentElement!;
		expect(summary.textContent).toMatch(/ref HEAD/i);
		expect(summary.textContent).toMatch(/replace mode/i);
	});
});
