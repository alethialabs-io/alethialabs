// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the runner picker's selection. Each opening starts from the online default runner (or
// "Any available" when there is none); a pick holds until the next opening. The default used to be
// set by an effect on every change of the list while open, which a live refresh turned into
// "your pick was undone"; it is now derived, so a list that arrives after opening still supplies it.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Runner = { id: string; name: string; status: string; is_default: boolean; operator: string };

const h = vi.hoisted(() => ({ runners: undefined as Runner[] | undefined }));

vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({
		data: h.runners === undefined ? undefined : { runners: h.runners },
		isPending: h.runners === undefined,
	}),
}));

import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";

const RUNNERS: Runner[] = [
	{ id: "r-default", name: "edge", status: "ONLINE", is_default: true, operator: "self" },
	{ id: "r-other", name: "spare", status: "ONLINE", is_default: false, operator: "self" },
];

/** The picker with a plain trigger. */
function picker(onConfirm: (id: string | null) => void) {
	return <RunnerSelectPopover trigger={<button type="button">Plan</button>} onConfirm={onConfirm} />;
}

beforeEach(() => {
	h.runners = RUNNERS;
});

describe("RunnerSelectPopover — the selection", () => {
	it("starts from the online default, and a pick holds until the next opening", () => {
		const onConfirm = vi.fn();
		render(picker(onConfirm));

		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).toHaveBeenLastCalledWith("r-default", false);

		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		fireEvent.click(screen.getByRole("button", { name: /spare/ }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).toHaveBeenLastCalledWith("r-other", false);

		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).toHaveBeenLastCalledWith("r-default", false);
	});

	it("takes the default from a list that arrives after opening", () => {
		h.runners = undefined;
		const onConfirm = vi.fn();
		const { rerender } = render(picker(onConfirm));
		fireEvent.click(screen.getByRole("button", { name: "Plan" }));

		h.runners = RUNNERS;
		rerender(picker(onConfirm));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).toHaveBeenLastCalledWith("r-default", false);
	});
});
