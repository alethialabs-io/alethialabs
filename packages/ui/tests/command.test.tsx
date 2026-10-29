// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CommandDialog's search must have an accessible name (#5824). cmdk points its input's
// `aria-labelledby` at its own hidden `<label cmdk-label>`, whose text is the root's `label` prop;
// left empty, that reference resolves to "" and blocks the placeholder fallback, so the shell
// command palette and both canvas palettes rendered an unnamed combobox. The dialog names its
// search after its `title`, which every caller already sets (or inherits as the default).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	Command,
	CommandDialog,
	CommandInput,
	CommandItem,
	CommandList,
} from "../src/command";

describe("CommandDialog", () => {
	it("names its search after the dialog title", async () => {
		render(
			<CommandDialog open title="Add a service">
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
			<CommandDialog open>
				<CommandInput placeholder="Search pages, projects, jobs…" />
				<CommandList />
			</CommandDialog>,
		);
		expect(
			await screen.findByRole("combobox", { name: "Command Palette" }),
		).toBeInTheDocument();
	});
});

// #6348 — the dialog's title and description sat OUTSIDE its popup, so a CLOSED palette still put
// "Add a service" / "Search and add infrastructure…" on the page: a heading for a dialog nobody had
// opened, read by a screen reader and counted as the page's content. They now live in the popup.
describe("CommandDialog's title and description", () => {
	it("are not on the page while the dialog is closed", () => {
		render(
			<CommandDialog open={false} title="Add a service" description="Search and add infrastructure.">
				<CommandList />
			</CommandDialog>,
		);
		expect(screen.queryByText("Add a service")).not.toBeInTheDocument();
		expect(screen.queryByText("Search and add infrastructure.")).not.toBeInTheDocument();
	});

	it("name and describe the dialog once it is open", async () => {
		render(
			<CommandDialog open title="Add a service" description="Search and add infrastructure.">
				<CommandList />
			</CommandDialog>,
		);
		const dialog = await screen.findByRole("dialog", { name: "Add a service" });
		expect(dialog).toHaveAccessibleDescription("Search and add infrastructure.");
		expect(dialog).toContainElement(screen.getByText("Add a service"));
	});
});

describe("Command", () => {
	it("passes its label through to cmdk, which names the input with it", () => {
		render(
			<Command label="Find project">
				<CommandInput placeholder="Find project…" />
				<CommandList />
			</Command>,
		);
		expect(
			screen.getByRole("combobox", { name: "Find project" }),
		).toBeInTheDocument();
	});
});
