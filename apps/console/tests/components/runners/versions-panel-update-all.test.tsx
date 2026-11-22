// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R6 C-18: "Update all (N)" queued one job per outdated runner on a single click, unconfirmed, and
// a partial failure named nothing. It now opens a confirmation that names the runners it will
// touch; the batch runs from the confirmation, and the outcome is one toast that says how many of
// how many were queued and NAMES the runners whose update was not (#7110). The panel's query hooks
// are stubbed; the panel and the confirmation are real. `updateEach` — the batch itself — is tested
// at the bottom against the real module with the server action stubbed.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Ref = { id: string; name: string };
type Outcome = { queued: Ref[]; failed: Ref[] };

const EDGE_EU = { id: "r1", name: "edge-eu" };
const EDGE_US = { id: "r2", name: "edge-us" };

const h = vi.hoisted(() => ({
	mutate: vi.fn(),
	updateRunnerAction: vi.fn(),
	toastSuccess: vi.fn(),
	toastWarning: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, warning: h.toastWarning, error: vi.fn() } }));
vi.mock("@/components/runners/release-notes-popover", () => ({
	ReleaseNotesPopover: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/app/server/actions/runners", () => ({
	deployRunnerAction: vi.fn(),
	destroyRunnerAction: vi.fn(),
	registerRunnerAction: vi.fn(),
	removeRunnerAction: vi.fn(),
	setDefaultRunnerAction: vi.fn(),
	updateRunnerAction: h.updateRunnerAction,
}));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({
		isPending: false,
		isError: false,
		refetch: vi.fn(),
		data: {
			latestRelease: { version: "1.4.0", is_breaking: false, released_at: "2026-11-01T00:00:00Z" },
			releases: [],
			runners: [
				{ id: "r1", name: "edge-eu", version: "1.3.0", in_place: true },
				{ id: "r2", name: "edge-us", version: "1.3.0", in_place: true },
				{ id: "r3", name: "laptop", version: "1.2.0", in_place: false },
				{ id: "r4", name: "fresh", version: "1.4.0", in_place: true },
			],
		},
	}),
	useUpdateAllOutdated: () => ({ mutate: h.mutate, isPending: false }),
}));

import { VersionsPanel, updateAllDescription, updateAllPartialMessage } from "@/components/runners/versions-panel";

beforeEach(() => {
	vi.clearAllMocks();
});

/** Makes the stubbed batch answer `outcome` through the options it was given. */
function answer(outcome: Outcome) {
	h.mutate.mockImplementation((_batch: Ref[], options?: { onSuccess?: (o: Outcome) => void; onSettled?: () => void }) => {
		options?.onSuccess?.(outcome);
		options?.onSettled?.();
	});
}

describe("Update all", () => {
	it("asks first, naming the runners it will update — and only those that can update in place", async () => {
		render(<VersionsPanel />);
		await userEvent.click(screen.getByRole("button", { name: "Update all (2)" }));
		const dialog = screen.getByRole("alertdialog");
		expect(dialog.textContent).toContain("Update 2 runners to v1.4.0?");
		expect(dialog.textContent).toContain("edge-eu, edge-us");
		expect(dialog.textContent).not.toContain("laptop");
		expect(dialog.textContent).not.toContain("fresh");
		expect(h.mutate).not.toHaveBeenCalled();
	});

	it("Cancel queues nothing", async () => {
		render(<VersionsPanel />);
		await userEvent.click(screen.getByRole("button", { name: "Update all (2)" }));
		await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
		expect(h.mutate).not.toHaveBeenCalled();
	});

	it("confirming queues exactly the listed runners and says all were queued", async () => {
		answer({ queued: [EDGE_EU, EDGE_US], failed: [] });
		render(<VersionsPanel />);
		await userEvent.click(screen.getByRole("button", { name: "Update all (2)" }));
		await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Update 2" }));
		expect(h.mutate).toHaveBeenCalledWith([EDGE_EU, EDGE_US], expect.anything());
		expect(h.toastSuccess).toHaveBeenCalledWith("2 updates queued");
	});

	it("a partial failure says how many of how many, names the runners not queued, and where they are", async () => {
		answer({ queued: [EDGE_EU], failed: [EDGE_US] });
		render(<VersionsPanel />);
		await userEvent.click(screen.getByRole("button", { name: "Update all (2)" }));
		await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Update 2" }));
		expect(h.toastSuccess).not.toHaveBeenCalled();
		const [message] = h.toastWarning.mock.calls[0] ?? [];
		expect(String(message)).toContain("1 of 2 updates queued");
		expect(String(message)).toContain("Not queued: edge-us.");
		expect(String(message)).not.toContain("edge-eu");
		expect(String(message)).toContain("update badge");
	});
});

describe("updateAllDescription", () => {
	it("names up to eight runners and counts the rest", () => {
		const names = Array.from({ length: 11 }, (_, i) => `r${i}`);
		const text = updateAllDescription(names, "2.0.0");
		expect(text).toContain("r0, r1, r2, r3, r4, r5, r6, r7 and 3 more");
		expect(text).not.toContain("r8,");
		expect(text).toContain("v2.0.0");
	});
});

describe("updateAllPartialMessage", () => {
	it("names up to eight runners that were not queued and counts the rest", () => {
		const names = Array.from({ length: 10 }, (_, i) => `f${i}`);
		const text = updateAllPartialMessage(3, names);
		expect(text).toContain("3 of 13 updates queued");
		expect(text).toContain("Not queued: f0, f1, f2, f3, f4, f5, f6, f7 and 2 more.");
		expect(text).not.toContain("f8");
	});
});

describe("updateEach (the batch behind Update all)", () => {
	/** The real `updateEach`; the module's own mock above stands in for the panel only. */
	async function realUpdateEach() {
		const actual = await vi.importActual<typeof import("@/lib/query/use-runners-query")>("@/lib/query/use-runners-query");
		return actual.updateEach;
	}

	it("sorts each runner by its own outcome — a refusal and a throw both land in failed, in order", async () => {
		const laptop = { id: "r3", name: "laptop" };
		h.updateRunnerAction.mockImplementation(async ({ runnerId }: { runnerId: string }) => {
			if (runnerId === "r2") return { ok: false, error: { kind: "conflict", message: "busy" } };
			if (runnerId === "r3") throw new Error("network");
			return { ok: true, data: { jobId: `job-${runnerId}` } };
		});
		const updateEach = await realUpdateEach();
		const result = await updateEach([EDGE_EU, EDGE_US, laptop]);
		expect(result).toEqual({ ok: true, data: { queued: [EDGE_EU], failed: [EDGE_US, laptop] } });
		expect(h.updateRunnerAction.mock.calls.map(([v]) => v)).toEqual([
			{ runnerId: "r1" },
			{ runnerId: "r2" },
			{ runnerId: "r3" },
		]);
	});

	it("all queued: nothing in failed", async () => {
		h.updateRunnerAction.mockResolvedValue({ ok: true, data: { jobId: "j" } });
		const updateEach = await realUpdateEach();
		expect(await updateEach([EDGE_EU, EDGE_US])).toEqual({ ok: true, data: { queued: [EDGE_EU, EDGE_US], failed: [] } });
	});
});
