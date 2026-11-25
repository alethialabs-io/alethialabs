// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A default runner is chosen per org. In a team org's runner list, a runner of the caller's personal
// workspace carries `personal_elsewhere: true`: its default star is gated with the reason (and never
// fires the mutation), while a runner of the addressed org keeps the live toggle.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setDefaultRunner = vi.fn();
const toastError = vi.fn();
const removeRunner = vi.hoisted(() => ({ mutate: vi.fn() }));
const destroyRunner = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useParams: () => ({ org: "acme" }) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock("@/components/runners/release-notes-popover", () => ({ ReleaseNotesPopover: () => null }));
// The picker is stood in for by one button that picks runner "r2" — what it renders is its own
// test's (runner-select-popover-default.test.tsx); here only the step after the pick matters.
vi.mock("@/components/runners/runner-select-popover", () => ({
	RunnerSelectPopover: ({
		title,
		confirmLabel,
		onConfirm,
	}: {
		title?: string;
		confirmLabel?: string;
		onConfirm: (runnerId: string | null) => void;
	}) => (
		<div data-testid="destroy-picker" data-title={title}>
			<button type="button" onClick={() => onConfirm("r2")}>
				{confirmLabel}
			</button>
		</div>
	),
}));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ data: undefined }),
	useSetDefaultRunner: () => ({ mutate: setDefaultRunner, isPending: false }),
	useDestroyRunner: () => ({ mutate: destroyRunner.mutate, isPending: false, isSuccess: false }),
	useDeleteRunner: () => ({ mutate: removeRunner.mutate, isPending: false }),
}));

import {
	PERSONAL_RUNNER_DEFAULT_REASON,
	RunnerActions,
	type RunnerRow,
} from "@/components/runners/runner-actions";

/** A registered self runner row, as the runners list hands it to the card. */
function row(overrides: Partial<RunnerRow>): RunnerRow {
	return {
		id: "r1",
		name: "build-box",
		operator: "self",
		provisioning: "registered",
		supported_providers: null,
		status: "ONLINE",
		last_heartbeat: null,
		version: null,
		location: null,
		is_default: false,
		in_place: false,
		cloud_instance_id: null,
		runner_releases: null,
		provisioned_hours: null,
		personal_elsewhere: false,
		active_job: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("default runner star", () => {
	it("a runner of the addressed org keeps the live toggle", async () => {
		render(<RunnerActions runner={row({})} />);
		const star = screen.getByRole("button", { name: "Set as default runner" });
		expect(star).toBeEnabled();
		await userEvent.click(star);
		expect(setDefaultRunner).toHaveBeenCalledWith("r1", expect.anything());
	});

	it("a personal-workspace runner listed from a team org is gated, with the reason, and fires nothing", async () => {
		render(<RunnerActions runner={row({ personal_elsewhere: true })} />);
		const star = screen.getByRole("button", { name: "Set as default runner" });
		expect(star).toBeDisabled();
		expect(star).toHaveAccessibleDescription(PERSONAL_RUNNER_DEFAULT_REASON);
		await userEvent.click(star);
		expect(setDefaultRunner).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});
});

describe("the job a runner is busy with (R6 C-04)", () => {
	it("links to the job under the org in the address, not the legacy /dashboard redirect", () => {
		render(
			<RunnerActions
				runner={row({ active_job: { id: "job-7", job_type: "UPDATE_RUNNER", project_name: null } })}
			/>,
		);
		expect(screen.getByRole("link", { name: /Updating/ }).getAttribute("href")).toBe("/acme/~/jobs/job-7");
	});
});

describe("removing a registered runner", () => {
	it("asks first, in plain words, and removes only on confirm", async () => {
		render(<RunnerActions runner={row({})} />);
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));
		const dialog = screen.getByRole("alertdialog");
		expect(dialog.textContent).toContain("Remove runner \u201Cbuild-box\u201D?");
		expect(dialog.textContent).not.toContain("database");
		expect(removeRunner.mutate).not.toHaveBeenCalled();
		await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
		expect(removeRunner.mutate).toHaveBeenCalledWith("r1", expect.anything());
	});
});

// CON-PB2, R6 C-20: a destroy was confirmed inside the runner picker, under a "Select runner"
// heading. The pick now leads to a typed confirmation that names the runner and what goes.
describe("destroying a deployed runner", () => {
	const deployed = row({ provisioning: "deployed", in_place: true });

	it("the picker is headed by the runner being destroyed", () => {
		render(<RunnerActions runner={deployed} />);
		expect(screen.getByTestId("destroy-picker").getAttribute("data-title")).toBe(
			"Destroy runner \u201Cbuild-box\u201D",
		);
	});

	it("asks for the runner's name before queuing the destroy on the picked runner", async () => {
		render(<RunnerActions runner={deployed} />);
		await userEvent.click(screen.getByRole("button", { name: "Continue to destroy" }));
		const dialog = screen.getByRole("alertdialog");
		expect(dialog.textContent).toContain("Destroy runner \u201Cbuild-box\u201D?");
		const confirm = within(dialog).getByRole("button", { name: "Destroy runner" });
		expect(confirm).toBeDisabled();
		await userEvent.type(within(dialog).getByRole("textbox"), "build-box");
		await waitFor(() => expect(confirm).toBeEnabled());
		await userEvent.click(confirm);
		await waitFor(() =>
			expect(destroyRunner.mutate).toHaveBeenCalledWith(
				{ runnerId: "r1", assignedRunnerId: "r2" },
				expect.anything(),
			),
		);
	});

	it("cancelling the confirmation queues nothing", async () => {
		render(<RunnerActions runner={deployed} />);
		await userEvent.click(screen.getByRole("button", { name: "Continue to destroy" }));
		await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
		expect(destroyRunner.mutate).not.toHaveBeenCalled();
	});
});
