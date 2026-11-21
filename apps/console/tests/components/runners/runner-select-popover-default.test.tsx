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

const h = vi.hoisted(() => ({ runners: undefined as Runner[] | undefined, isError: false, refetch: vi.fn() }));

vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({
		data: h.runners === undefined ? undefined : { runners: h.runners },
		isPending: h.runners === undefined && !h.isError,
		isError: h.isError,
		refetch: h.refetch,
	}),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

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
	h.isError = false;
	h.refetch.mockClear();
});

describe("RunnerSelectPopover — the selection", () => {
	it("starts from the online default, and a pick holds until the next opening", () => {
		const onConfirm = vi.fn();
		render(picker(onConfirm));

		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).toHaveBeenLastCalledWith("r-default", false);

		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		fireEvent.click(screen.getByRole("radio", { name: /spare/ }));
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
		fireEvent.click(screen.getByRole("radio", { name: /spare/ }));

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
		fireEvent.click(screen.getByRole("radio", { name: /spare/ }));

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

describe("RunnerSelectPopover — a radio group with a name (R6 C-23)", () => {
	it("names the group and marks the selected option", () => {
		render(picker(vi.fn()));
		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		expect(screen.getByRole("radiogroup", { name: "Select runner" })).toBeTruthy();
		expect(screen.getByRole("radio", { name: /edge/ }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("radio", { name: /Any available/ }).getAttribute("aria-checked")).toBe("false");
		fireEvent.click(screen.getByRole("radio", { name: /Any available/ }));
		expect(screen.getByRole("radio", { name: /Any available/ }).getAttribute("aria-checked")).toBe("true");
	});
});

describe("RunnerSelectPopover — nothing to run the job (R6 C-21)", () => {
	it("with no runner registered, Confirm is disabled and Register is offered", () => {
		h.runners = [];
		const onConfirm = vi.fn();
		render(picker(onConfirm));
		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
		const register = screen.getByRole("link", { name: "Register a runner" });
		expect(register.getAttribute("href")).toBe("/acme/~/runners");
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("a destroy that excludes the only runner may still confirm: the org has a runner", () => {
		h.runners = [RUNNERS[0]];
		const onConfirm = vi.fn();
		render(
			<RunnerSelectPopover
				trigger={<button type="button">Destroy it</button>}
				onConfirm={onConfirm}
				excludeId="r-default"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Destroy it" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onConfirm).toHaveBeenCalledWith(null, false);
	});

	it("a failed read says so with a retry, and Confirm stays disabled", () => {
		h.runners = undefined;
		h.isError = true;
		render(picker(vi.fn()));
		fireEvent.click(screen.getByRole("button", { name: "Plan" }));
		expect(screen.getByRole("alert").textContent).toContain("couldn");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(h.refetch).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
	});
});
