// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A default runner is chosen per org. In a team org's runner list, a runner of the caller's personal
// workspace carries `personal_elsewhere: true`: its default star is gated with the reason (and never
// fires the mutation), while a runner of the addressed org keeps the live toggle.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setDefaultRunner = vi.fn();
const toastError = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock("@/components/runners/release-notes-popover", () => ({ ReleaseNotesPopover: () => null }));
vi.mock("@/components/runners/runner-select-popover", () => ({ RunnerSelectPopover: () => null }));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ data: undefined }),
	useSetDefaultRunner: () => ({ mutate: setDefaultRunner, isPending: false }),
	useDestroyRunner: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
	useDeleteRunner: () => ({ mutate: vi.fn(), isPending: false }),
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
