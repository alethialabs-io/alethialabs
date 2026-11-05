// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the runner picker's selection. Each opening starts from the online default runner (or
// "Any available" when there is none). A pick holds through a live refresh while its runner is still
// selectable, and falls back to the default when it is not. The default used to be set by an effect
// on every change of the list while open, which undid a valid pick on each refresh: "keeps a pick
// through a live refresh" is the case that fails against that code.

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

	it("keeps a pick through a live refresh while its runner stays online", () => {
		const onConfirm = vi.fn();
		const { rerender } = render(picker(onConfirm));
		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		fireEvent.click(screen.getByRole("button", { name: /spare/ }));

		// The `runners` topic refetches: a new array of the same rows.
		h.runners = RUNNERS.map((r) => ({ ...r }));
		rerender(picker(onConfirm));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).toHaveBeenLastCalledWith("r-other", false);
	});

	it("falls back to the default when the picked runner goes offline in a live refresh", () => {
		const onConfirm = vi.fn();
		const { rerender } = render(picker(onConfirm));
		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		fireEvent.click(screen.getByRole("button", { name: /spare/ }));

		h.runners = RUNNERS.map((r) => (r.id === "r-other" ? { ...r, status: "OFFLINE" } : { ...r }));
		rerender(picker(onConfirm));
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
