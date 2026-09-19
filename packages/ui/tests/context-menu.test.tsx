// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the pointer-positioned ContextMenu: closed renders nothing, open renders the items
// against a zero-size virtual anchor at the given point, an item's onSelect fires and asks the
// root to close, a disabled item is inert, a checkbox item toggles without closing, and Escape
// reaches the caller as onOpenChange(false).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	virtualAnchor,
} from "../src/context-menu";

/** A representative menu: a label, two items (one disabled), a separator and a checkbox item. */
function Menu({
	open,
	onOpenChange,
	onSelect,
	onDisabledSelect,
	checked = false,
	onCheckedChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect?: () => void;
	onDisabledSelect?: () => void;
	checked?: boolean;
	onCheckedChange?: (checked: boolean) => void;
}) {
	return (
		<ContextMenu
			open={open}
			onOpenChange={onOpenChange}
			anchor={{ x: 120, y: 80 }}
		>
			<ContextMenuContent>
				<ContextMenuLabel>Node</ContextMenuLabel>
				<ContextMenuItem onSelect={onSelect}>Duplicate</ContextMenuItem>
				<ContextMenuItem disabled onSelect={onDisabledSelect}>
					Delete
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuCheckboxItem
					checked={checked}
					onCheckedChange={onCheckedChange}
				>
					Show minimap
				</ContextMenuCheckboxItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

describe("virtualAnchor", () => {
	it("reports a zero-size rect at the point", () => {
		const rect = virtualAnchor({ x: 120, y: 80 }).getBoundingClientRect();
		expect(rect).toEqual({
			x: 120,
			y: 80,
			width: 0,
			height: 0,
			top: 80,
			left: 120,
			right: 120,
			bottom: 80,
		});
	});
});

describe("ContextMenu", () => {
	it("renders nothing while closed", () => {
		render(<Menu open={false} onOpenChange={() => {}} />);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(screen.queryByText("Duplicate")).not.toBeInTheDocument();
	});

	it("stays closed when open but given no anchor", () => {
		render(
			<ContextMenu open onOpenChange={() => {}} anchor={null}>
				<ContextMenuContent>
					<ContextMenuItem>Duplicate</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>,
		);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("renders the items at the anchor point when open", async () => {
		render(<Menu open onOpenChange={() => {}} />);
		const menu = await screen.findByRole("menu");
		expect(menu).toBeInTheDocument();
		expect(menu).toHaveAttribute("data-slot", "context-menu-content");
		expect(screen.getByText("Node")).toHaveAttribute(
			"data-slot",
			"context-menu-label",
		);
		expect(
			screen.getByRole("menuitem", { name: "Duplicate" }),
		).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
			"data-disabled",
		);
		expect(screen.getByRole("separator")).toHaveAttribute(
			"data-slot",
			"context-menu-separator",
		);
		expect(
			screen.getByRole("menuitemcheckbox", { name: "Show minimap" }),
		).toHaveAttribute("aria-checked", "false");
		// The positioner is the popup's parent; base-ui stamps the side/align it RESOLVED against
		// the anchor. Their values are not asserted: jsdom measures every rect as 0x0, so collision
		// avoidance flips the requested bottom/start to top/end — a measurement artefact, not the
		// component. What the anchor itself reports is pinned by the virtualAnchor test above.
		const positioner = menu.parentElement;
		expect(positioner).not.toBeNull();
		expect(positioner).toHaveAttribute("data-side");
		expect(positioner).toHaveAttribute("data-align");
	});

	it("fires onSelect on an item and asks the root to close", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		const onOpenChange = vi.fn();
		render(<Menu open onOpenChange={onOpenChange} onSelect={onSelect} />);

		await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
		expect(onSelect).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("does not fire a disabled item", async () => {
		const user = userEvent.setup();
		const onDisabledSelect = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<Menu
				open
				onOpenChange={onOpenChange}
				onDisabledSelect={onDisabledSelect}
			/>,
		);

		await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
		expect(onDisabledSelect).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("toggles a checkbox item through onCheckedChange without closing", async () => {
		const user = userEvent.setup();
		const onCheckedChange = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<Menu
				open
				onOpenChange={onOpenChange}
				checked={false}
				onCheckedChange={onCheckedChange}
			/>,
		);

		await user.click(
			await screen.findByRole("menuitemcheckbox", { name: "Show minimap" }),
		);
		expect(onCheckedChange).toHaveBeenCalledTimes(1);
		expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("closes on Escape through onOpenChange", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		render(<Menu open onOpenChange={onOpenChange} />);

		await screen.findByRole("menu");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});
