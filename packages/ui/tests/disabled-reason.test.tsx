// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A disabled control must still SAY WHY — to a pointer, a keyboard and a screen reader (#4996, the
// review of #5000). The pattern it replaced, `disabled` + `title`, reached none of them: the button's
// `disabled:pointer-events-none` swallows the hover, a disabled <button> takes no focus, and a menu
// item's `data-[disabled]:pointer-events-none` does the same to the row.
//
// Each test below asserts one of those three channels, plus that the control never fires.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../src/button";
import { Command, CommandGroup, CommandItem, CommandList } from "../src/command";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
} from "../src/context-menu";
import { DisabledReason } from "../src/disabled-reason";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../src/dropdown-menu";

const WHY = "Not enabled on this instance";

/** A gated button, the way the console writes one. */
function Gated({ reason, onClick }: { reason: string | null; onClick: () => void }) {
	return (
		<DisabledReason reason={reason}>
			<Button onClick={onClick}>Link GitHub</Button>
		</DisabledReason>
	);
}

/** The focusable element that carries the reason — the one a keyboard user lands on. */
function wrapperOf(control: HTMLElement): HTMLElement {
	const wrapper = control.closest<HTMLElement>('[data-slot="disabled-reason"]');
	if (wrapper === null) throw new Error("the control has no DisabledReason wrapper");
	return wrapper;
}

describe("DisabledReason", () => {
	it("disables the control and describes it with the reason", () => {
		render(<Gated reason={WHY} onClick={vi.fn()} />);
		const button = screen.getByRole("button", { name: "Link GitHub" });
		expect(button).toBeDisabled();
		expect(button).toHaveAccessibleDescription(WHY);
		// The reason is not carried by a `title`: a disabled button never shows one.
		expect(button).not.toHaveAttribute("title");
	});

	it("gives a keyboard user a stop that opens the reason as a tooltip", async () => {
		const user = userEvent.setup();
		render(
			<>
				<button type="button">Before</button>
				<Gated reason={WHY} onClick={vi.fn()} />
			</>,
		);
		const wrapper = wrapperOf(screen.getByRole("button", { name: "Link GitHub" }));
		await user.click(screen.getByRole("button", { name: "Before" }));
		await user.tab();
		expect(wrapper).toHaveFocus();
		expect(wrapper).toHaveAccessibleDescription(WHY);
		await waitFor(() => expect(tooltip()).toHaveTextContent(WHY));
	});

	it("opens the reason as a tooltip on hover", async () => {
		const user = userEvent.setup();
		render(<Gated reason={WHY} onClick={vi.fn()} />);
		await user.hover(wrapperOf(screen.getByRole("button", { name: "Link GitHub" })));
		await waitFor(() => expect(tooltip()).toHaveTextContent(WHY));
	});

	it("never fires the control's handler", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(<Gated reason={WHY} onClick={onClick} />);
		const button = screen.getByRole("button", { name: "Link GitHub" });
		await user.click(wrapperOf(button));
		await user.click(button);
		wrapperOf(button).focus();
		await user.keyboard("{Enter} ");
		expect(onClick).not.toHaveBeenCalled();
	});

	it("renders the control untouched when there is no reason", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(<Gated reason={null} onClick={onClick} />);
		const button = screen.getByRole("button", { name: "Link GitHub" });
		expect(button).toBeEnabled();
		expect(button).not.toHaveAttribute("aria-describedby");
		expect(button.closest('[data-slot="disabled-reason"]')).toBeNull();
		await user.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("keeps a description the control already had", () => {
		render(
			<>
				<p id="hint">Links your account</p>
				<DisabledReason reason={WHY}>
					<Button aria-describedby="hint">Link GitHub</Button>
				</DisabledReason>
			</>,
		);
		expect(screen.getByRole("button", { name: "Link GitHub" })).toHaveAccessibleDescription(
			`Links your account ${WHY}`,
		);
	});
});

/** The open tooltip's popup, or null. */
function tooltip(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

describe("disabledReason on menu and command items", () => {
	const FIT = "Nothing on the board to fit";

	it("a dropdown item shows the reason in the row, is described by it, and does not fire", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<DropdownMenu>
				<DropdownMenuTrigger>More</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem disabledReason={FIT} onSelect={onSelect}>
						Fit view
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		await user.click(screen.getByRole("button", { name: "More" }));
		const item = await screen.findByRole("menuitem", { name: "Fit view" });
		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(item).toHaveAccessibleDescription(FIT);
		expect(screen.getByText(FIT)).toBeVisible();
		await user.click(item);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("a context menu item shows the reason in the row, is described by it, and does not fire", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<ContextMenu open onOpenChange={() => {}} anchor={{ x: 10, y: 10 }}>
				<ContextMenuContent>
					<ContextMenuItem disabledReason={FIT} onSelect={onSelect}>
						Fit view
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>,
		);
		const item = await screen.findByRole("menuitem", { name: "Fit view" });
		expect(item).toHaveAttribute("data-disabled");
		expect(item).toHaveAccessibleDescription(FIT);
		expect(screen.getByText(FIT)).toBeVisible();
		await user.click(item);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("a command item shows the reason in the row, is described by it, and does not run", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<Command>
				<CommandList>
					<CommandGroup>
						<CommandItem value="fit-view" disabledReason={FIT} onSelect={onSelect}>
							Fit view
						</CommandItem>
					</CommandGroup>
				</CommandList>
			</Command>,
		);
		const item = screen.getByRole("option", { name: "Fit view" });
		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(item).toHaveAccessibleDescription(FIT);
		await user.click(item);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("an item with no reason is live and undescribed", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<Command>
				<CommandList>
					<CommandItem value="fit-view" disabledReason={null} onSelect={onSelect}>
						Fit view
					</CommandItem>
				</CommandList>
			</Command>,
		);
		const item = screen.getByRole("option", { name: "Fit view" });
		expect(item).not.toHaveAttribute("aria-describedby");
		await user.click(item);
		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});
