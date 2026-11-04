// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `@repo/ui/command` on Base UI's Autocomplete (#6145).
//
// Names (#5824): under cmdk the input's `aria-labelledby` pointed at cmdk's own hidden
// `<label cmdk-label>`; left empty, that reference resolved to "" and blocked the placeholder
// fallback, so the shell command palette and both canvas palettes rendered an unnamed combobox. The
// wrapper now gives the input the root's `label` as its `aria-label`, and the dialog names its
// search after its `title`, which every caller already sets (or inherits as the default).
//
// Behaviour: the rows shown are the caller's ranked `filteredItems` (Base UI's own filter is off),
// Enter runs the highlighted row, the highlight does not wrap unless asked, a disabled row never
// runs, and a miss shows the empty text.

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../src/command";
import { useCommandSearch } from "../src/command-search";
import { pasteQuery } from "./interactions";

const ROWS = ["workshop", "my-shop", "shopfront", "shop", "billing"];

/** The rows' search text: the row itself. */
const self = (row: string): string => row;

/**
 * A `Command` over `rows` in one "Rows" group, ranked by the shared ranker (with `disabled` rows
 * ranked last, as consumers do), reporting each chosen row. `pinned` adds an action row that is
 * shown whatever the search.
 */
function Harness({
	rows = ROWS,
	onPick,
	loopFocus,
	disabled = [],
	pinned,
}: {
	rows?: string[];
	onPick: (row: string) => void;
	loopFocus?: boolean;
	disabled?: string[];
	pinned?: string;
}) {
	const s = useCommandSearch(rows, self, { isDisabled: (row) => disabled.includes(row) });
	return (
		<Command
			label="Find row"
			search={s.search}
			onSearchChange={s.onSearchChange}
			filteredItems={s.results}
			pinnedItems={pinned ? [pinned] : undefined}
			loopFocus={loopFocus}
		>
			<CommandInput placeholder="Find row…" />
			<CommandList>
				<CommandEmpty>No row found.</CommandEmpty>
				<CommandGroup heading="Rows">
					{s.results.map((row) => (
						<CommandItem
							key={row}
							disabled={disabled.includes(row)}
							onSelect={() => onPick(row)}
						>
							{row}
						</CommandItem>
					))}
				</CommandGroup>
				{pinned && (
					<CommandGroup>
						<CommandItem onSelect={() => onPick(pinned)}>{pinned}</CommandItem>
					</CommandGroup>
				)}
			</CommandList>
		</Command>
	);
}

/** The visible rows, in order. */
const listed = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("CommandDialog", () => {
	it("names its search after the dialog title", async () => {
		render(
			<CommandDialog open title="Add a service" filteredItems={["Postgres"]}>
				<CommandInput placeholder="Search services…" />
				<CommandList>
					<CommandItem>Postgres</CommandItem>
				</CommandList>
			</CommandDialog>,
		);
		expect(
			await screen.findByRole("combobox", { name: "Add a service" }),
		).toHaveAttribute("placeholder", "Search services…");
	});

	it("names its search with the default title when the caller sets none", async () => {
		render(
			<CommandDialog open filteredItems={[]}>
				<CommandInput placeholder="Search pages, projects, jobs…" />
				<CommandList />
			</CommandDialog>,
		);
		expect(
			await screen.findByRole("combobox", { name: "Command Palette" }),
		).toBeInTheDocument();
	});

	it("closes on Escape from its search", async () => {
		const onOpenChange = vi.fn();
		render(
			<CommandDialog open onOpenChange={onOpenChange} filteredItems={["Postgres"]}>
				<CommandInput placeholder="Search services…" />
				<CommandList>
					<CommandItem>Postgres</CommandItem>
				</CommandList>
			</CommandDialog>,
		);
		const box = await screen.findByRole("combobox", { name: "Command Palette" });
		fireEvent.keyDown(box, { key: "Escape" });
		expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
	});
});

// #6348 — the dialog's title and description sat OUTSIDE its popup, so a CLOSED palette still put
// "Add a service" / "Search and add infrastructure…" on the page: a heading for a dialog nobody had
// opened, read by a screen reader and counted as the page's content. They now live in the popup.
describe("CommandDialog's title and description", () => {
	it("are not on the page while the dialog is closed", () => {
		render(
			<CommandDialog
				open={false}
				title="Add a service"
				description="Search and add infrastructure."
				filteredItems={[]}
			>
				<CommandList />
			</CommandDialog>,
		);
		expect(screen.queryByText("Add a service")).not.toBeInTheDocument();
		expect(screen.queryByText("Search and add infrastructure.")).not.toBeInTheDocument();
	});

	it("name and describe the dialog once it is open", async () => {
		render(
			<CommandDialog
				open
				title="Add a service"
				description="Search and add infrastructure."
				filteredItems={[]}
			>
				<CommandList />
			</CommandDialog>,
		);
		const dialog = await screen.findByRole("dialog", { name: "Add a service" });
		expect(dialog).toHaveAccessibleDescription("Search and add infrastructure.");
		// The title is the dialog's own heading (the search box carries the same words as its name).
		expect(within(dialog).getByRole("heading", { name: "Add a service" })).toBeInTheDocument();
	});
});

describe("Command", () => {
	it("names its search input with its label", () => {
		render(
			<Command label="Find project" filteredItems={[]}>
				<CommandInput placeholder="Find project…" />
				<CommandList />
			</Command>,
		);
		expect(
			screen.getByRole("combobox", { name: "Find project" }),
		).toBeInTheDocument();
	});

	it("lists the ranked rows, best match first", async () => {
		const user = userEvent.setup({ delay: null });
		render(<Harness onPick={() => {}} />);
		expect(listed()).toEqual(ROWS);
		await pasteQuery(user, screen.getByRole("combobox", { name: "Find row" }), "shop");
		expect(listed()).toEqual(["shop", "shopfront", "my-shop", "workshop"]);
	});

	it("shows the empty text on a miss, and not while rows match", async () => {
		const user = userEvent.setup({ delay: null });
		render(<Harness onPick={() => {}} />);
		expect(screen.queryByText("No row found.")).not.toBeInTheDocument();
		await pasteQuery(user, screen.getByRole("combobox", { name: "Find row" }), "zzz");
		expect(screen.queryAllByRole("option")).toEqual([]);
		expect(screen.getByText("No row found.")).toBeInTheDocument();
	});

	it("leaves no orphan group heading on a miss", async () => {
		const user = userEvent.setup({ delay: null });
		render(<Harness onPick={() => {}} />);
		expect(screen.getByText("Rows")).toBeInTheDocument();
		await pasteQuery(user, screen.getByRole("combobox", { name: "Find row" }), "zzz");
		expect(screen.queryByText("Rows")).not.toBeInTheDocument();
		expect(screen.queryAllByRole("group")).toEqual([]);
	});

	it("renders a pinned row after every result", () => {
		render(<Harness onPick={() => {}} pinned="New row" />);
		expect(listed().at(-1)).toBe("New row");
	});

	it("on a miss highlights nothing, so Enter runs nothing until ArrowDown reaches the pinned row", async () => {
		const user = userEvent.setup({ delay: null });
		const onPick = vi.fn();
		render(<Harness onPick={onPick} pinned="New row" />);
		await pasteQuery(user, screen.getByRole("combobox", { name: "Find row" }), "zzz");
		expect(screen.getByText("No row found.")).toBeInTheDocument();
		expect(document.querySelector("[data-highlighted]")).toBeNull();
		await user.keyboard("{Enter}");
		expect(onPick).not.toHaveBeenCalled();
		await user.keyboard("{ArrowDown}");
		expect(screen.getByRole("option", { name: "New row" })).toHaveAttribute("data-highlighted");
		await user.keyboard("{Enter}");
		expect(onPick).toHaveBeenCalledWith("New row");
	});

	it("starts the highlight on the best ENABLED match, so Enter runs it", async () => {
		const user = userEvent.setup({ delay: null });
		const onPick = vi.fn();
		render(<Harness onPick={onPick} disabled={["shop"]} />);
		await pasteQuery(user, screen.getByRole("combobox", { name: "Find row" }), "shop");
		expect(listed()).toEqual(["shopfront", "my-shop", "workshop", "shop"]);
		await user.keyboard("{Enter}");
		expect(onPick).toHaveBeenCalledWith("shopfront");
	});

	it("runs the first match on Enter", async () => {
		const user = userEvent.setup({ delay: null });
		const onPick = vi.fn();
		render(<Harness onPick={onPick} />);
		await pasteQuery(user, screen.getByRole("combobox", { name: "Find row" }), "shop");
		await user.keyboard("{Enter}");
		expect(onPick).toHaveBeenCalledWith("shop");
	});

	it("does not wrap the highlight from the last row to the first", async () => {
		const user = userEvent.setup({ delay: null });
		const onPick = vi.fn();
		render(<Harness rows={["alpha", "beta"]} onPick={onPick} />);
		await user.click(screen.getByRole("combobox", { name: "Find row" }));
		// The highlight starts on "alpha". One ArrowDown reaches "beta", the last row; the second
		// would wrap back to "alpha" if the list looped, and stays on "beta" because it does not.
		await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick).toHaveBeenCalledWith("beta");
	});

	it("wraps when a caller asks for it (the control for the test above)", async () => {
		const user = userEvent.setup({ delay: null });
		const onPick = vi.fn();
		render(<Harness rows={["alpha", "beta"]} onPick={onPick} loopFocus />);
		await user.click(screen.getByRole("combobox", { name: "Find row" }));
		await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
		expect(onPick).toHaveBeenCalledWith("alpha");
	});

	it("never runs a disabled row", async () => {
		const user = userEvent.setup({ delay: null });
		const onPick = vi.fn();
		render(<Harness rows={["alpha", "beta"]} disabled={["alpha"]} onPick={onPick} />);
		await user.click(screen.getByText("alpha"));
		expect(onPick).not.toHaveBeenCalled();
	});
});
