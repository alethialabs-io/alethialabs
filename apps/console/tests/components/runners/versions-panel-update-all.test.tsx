// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R6 C-18: "Update all (N)" queued one job per outdated runner on a single click, unconfirmed, and
// a partial failure named nothing. It now opens a confirmation that names the runners it will
// touch; the batch runs from the confirmation, and the outcome is one toast that says how many of
// how many were queued. The query hooks are stubbed; the panel and the confirmation are real.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Outcome = { queued: number; failed: number };

const h = vi.hoisted(() => ({
	mutate: vi.fn(),
	toastSuccess: vi.fn(),
	toastWarning: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, warning: h.toastWarning, error: vi.fn() } }));
vi.mock("@/components/runners/release-notes-popover", () => ({
	ReleaseNotesPopover: ({ children }: { children: ReactNode }) => children,
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

import { VersionsPanel, updateAllDescription } from "@/components/runners/versions-panel";

beforeEach(() => {
	vi.clearAllMocks();
});

/** Makes the stubbed batch answer `outcome` through the options it was given. */
function answer(outcome: Outcome) {
	h.mutate.mockImplementation((_ids: string[], options?: { onSuccess?: (o: Outcome) => void; onSettled?: () => void }) => {
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
		answer({ queued: 2, failed: 0 });
		render(<VersionsPanel />);
		await userEvent.click(screen.getByRole("button", { name: "Update all (2)" }));
		await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Update 2" }));
		expect(h.mutate).toHaveBeenCalledWith(["r1", "r2"], expect.anything());
		expect(h.toastSuccess).toHaveBeenCalledWith("2 updates queued");
	});

	it("a partial failure says how many of how many, and where to find the rest", async () => {
		answer({ queued: 1, failed: 1 });
		render(<VersionsPanel />);
		await userEvent.click(screen.getByRole("button", { name: "Update all (2)" }));
		await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Update 2" }));
		const [message] = h.toastWarning.mock.calls[0] ?? [];
		expect(String(message)).toContain("1 of 2 updates queued");
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
