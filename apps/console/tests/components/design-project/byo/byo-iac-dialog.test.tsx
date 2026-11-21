// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component tests for the BYO IaC attach dialog: the four-step wizard advances only when the step's
// fields validate (scalar-only var rows: empty/duplicate names block), and Review calls
// attachIacSource with the collected repo/path/ref + folded scalar var_values. The heavy
// RepositorySelector (git-provider auth + server fetch) is stubbed to a plain input so the wizard is
// tested in isolation. The attach is on the mutation contract (#6119): the dialog hands
// `attachIacSourceAction` to `useActionMutation`, which answers an `ActionResult`.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ByoIacDialog,
	EXAMPLE_IAC_PATH,
	EXAMPLE_IAC_REPO_URL,
} from "@/components/design-project/byo/byo-iac-dialog";
import { resetTestPage } from "@/tests/components/design-project/byo/byo-wizard-harness";

const { attachIacSource } = vi.hoisted(() => ({ attachIacSource: vi.fn() }));
vi.mock("@/app/server/actions/byo-iac", () => ({
	attachIacSourceAction: (input: unknown) => attachIacSource(input),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// The dialog's open state and step live in the URL; the harness holds that URL in a store.
vi.mock("@/lib/wizard/location", async (importOriginal) => {
	const harness = await import("@/tests/components/design-project/byo/byo-wizard-harness");
	return {
		...(await importOriginal<typeof import("@/lib/wizard/location")>()),
		useWizardEnvironment: harness.useTestWizardEnvironment,
	};
});
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});

// Stub the git-provider selector to a plain input — its auth/fetch internals aren't under test. It
// forwards `placeholder`, because the real selector shows it as the empty trigger's label: it is the
// example the user reads.
vi.mock("@/components/repository-selector", () => ({
	RepositorySelector: ({
		value,
		onChange,
		placeholder,
	}: {
		value: string;
		onChange: (v: string) => void;
		placeholder?: string;
	}) => (
		<input
			aria-label="Module repository"
			value={value}
			placeholder={placeholder}
			onChange={(e) => onChange(e.target.value)}
		/>
	),
}));

const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
	resetTestPage();
	attachIacSource.mockReset();
	attachIacSource.mockResolvedValue({ ok: true, data: { id: "src-1" } });
	toast.success.mockReset();
	toast.error.mockReset();
});

/** Renders the dialog as the canvas asks for it, and waits for the wizard's first step. */
async function renderDialog() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={client}>
			<ByoIacDialog
				open
				onOpenChange={() => {}}
				projectId="proj-1"
				environmentId="env-1"
				onAttached={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	// Until the draft is read the dialog shows its skeleton, which has no repository field.
	await screen.findByLabelText("Module repository");
	return view;
}

/** Advances the wizard from Repository → Path & ref by entering a repo URL. */
async function toPathStep(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("Module repository"), "https://github.com/acme/infra-tofu");
	await user.click(screen.getByRole("button", { name: /next/i }));
}

describe("ByoIacDialog", () => {
	it("blocks advancing past Repository without a valid repo URL", async () => {
		const user = userEvent.setup();
		await renderDialog();
		// No URL yet → still on the Repository step.
		await user.click(screen.getByRole("button", { name: /next/i }));
		expect(screen.getByLabelText("Module repository")).toBeInTheDocument();
		expect(await screen.findByText(/valid git repository url/i)).toBeInTheDocument();
	});

	it("validates scalar var rows — an empty variable name blocks the Variables step", async () => {
		const user = userEvent.setup();
		await renderDialog();
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
		await renderDialog();
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
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("IaC source attached — scanning the module now."),
		);
	});

	it("says a refusal inside the dialog, toasts nothing, and stays on Review", async () => {
		const refusal =
			"This Fabric already has an IaC source attached — detach it before attaching another.";
		attachIacSource.mockResolvedValue({ ok: false, error: { kind: "conflict", message: refusal } });
		const user = userEvent.setup();
		await renderDialog();
		await toPathStep(user);
		await user.click(screen.getByRole("button", { name: /next/i })); // → Variables
		await user.click(screen.getByRole("button", { name: /next/i })); // → Review
		await user.click(screen.getByRole("button", { name: /attach source/i }));

		expect(await screen.findByText(refusal)).toBeInTheDocument();
		expect(toast.error).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /attach source/i })).toBeEnabled();
	});

	it("shows the module coords on the Review step", async () => {
		const user = userEvent.setup();
		await renderDialog();
		await toPathStep(user);
		await user.click(screen.getByRole("button", { name: /next/i })); // → Variables
		await user.click(screen.getByRole("button", { name: /next/i })); // → Review
		const review = await screen.findByText(/github\.com\/acme\/infra-tofu/i);
		// Coords render inside the review summary block (repo line + path/ref line + count line).
		const summary = review.parentElement!;
		expect(summary.textContent).toMatch(/ref HEAD/i);
		expect(summary.textContent).toMatch(/replace mode/i);
	});
	// #6728's pattern: Next and Attach share a slot, and Next awaits `trigger` before `setStep`. In a
	// browser the step change lands before the click's activation, so a re-typed node would submit.
	// jsdom activates before microtasks, so these pin what closes the race (see the support wizard's
	// submit-only-on-contact test for the full mechanism).
	it("Next into Review cancels its click and Attach is a new node — one click never attaches", async () => {
		const user = userEvent.setup();
		await renderDialog();
		await toPathStep(user);
		await user.click(screen.getByRole("button", { name: /next/i })); // → Variables
		const nextButton = screen.getByRole("button", { name: /next/i });

		const proceeded = fireEvent.click(nextButton); // → Review

		const attachButton = await screen.findByRole("button", { name: /attach source/i });
		expect(proceeded).toBe(false);
		expect(attachButton).not.toBe(nextButton);
		expect(nextButton.isConnected).toBe(false);
		expect(attachIacSource).not.toHaveBeenCalled();
	});

	it("Enter before Review (an implicit form submit) advances instead of attaching", async () => {
		const user = userEvent.setup();
		await renderDialog();
		await user.type(screen.getByLabelText("Module repository"), "https://github.com/acme/infra-tofu");
		const form = screen.getByLabelText("Module repository").closest("form");
		if (!form) throw new Error("the dialog renders no form");

		fireEvent.submit(form);

		expect(await screen.findByLabelText(/root-module path/i)).toBeInTheDocument();
		expect(attachIacSource).not.toHaveBeenCalled();
	});

	// #6841: the example a user reads names something that exists. It used to be
	// `github.com/acme/infra-tofu`, which 404s.
	it("pins the worked example: a public repository of root modules and one module's path", () => {
		// Changed one? Fetch the new value first: the point is that it can be pasted and attached.
		expect(EXAMPLE_IAC_REPO_URL).toBe("https://github.com/alethialabs-io/alethia-examples");
		expect(EXAMPLE_IAC_PATH).toBe("iac/drift/aws");
	});

	it("shows no repository example but the worked one, and no acme, on any step", async () => {
		const user = userEvent.setup();
		const seen: string[] = [];
		/** Every repository-shaped example on screen: rendered text plus placeholders. */
		const sweep = () => {
			const placeholders = Array.from(document.body.querySelectorAll("[placeholder]")).map(
				(el) => el.getAttribute("placeholder") ?? "",
			);
			for (const source of [document.body.textContent ?? "", ...placeholders]) {
				seen.push(...(source.match(/https?:\/\/[^\s"'<>),]*github[^\s"'<>),]*/g) ?? []));
				expect(source).not.toMatch(/acme/i);
			}
		};

		await renderDialog();
		sweep();
		await user.type(screen.getByLabelText("Module repository"), EXAMPLE_IAC_REPO_URL);
		await user.click(screen.getByRole("button", { name: /next/i }));
		await screen.findByLabelText(/root-module path/i);
		sweep();
		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.click(await screen.findByRole("button", { name: /add/i }));
		sweep();
		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.type(screen.getByLabelText(/variable 1 name/i), "drift_marker");
		await user.click(screen.getByRole("button", { name: /next/i }));
		await screen.findByText(/replace mode · scan on attach/i);
		sweep();

		// The sweep must have SEEN something, or an empty result would read as a clean one.
		expect(seen.length).toBeGreaterThan(0);
		expect([...new Set(seen)].filter((example) => example !== EXAMPLE_IAC_REPO_URL)).toEqual([]);
	});
});
