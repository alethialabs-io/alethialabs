// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE frame every inspector subject is drawn in. What is pinned is the pattern itself: where
// the name, the state, the one action, the tabs and the messages are, and that the frame has no
// commit button of its own.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	INSPECTOR_TAB_LABEL,
	InspectorAction,
	InspectorFrame,
} from "@/components/design-project/canvas/inspector-shell/inspector-frame";

describe("InspectorFrame", () => {
	it("says what the subject is, in a heading, with its kind and one line about it", () => {
		render(
			<InspectorFrame
				eyebrow="Environment"
				title="Environment settings"
				summary="prod · production"
				onClose={vi.fn()}
			>
				<p>body</p>
			</InspectorFrame>,
		);
		expect(screen.getByRole("heading", { level: 2, name: "Environment settings" })).toBeInTheDocument();
		expect(screen.getByText("Environment")).toBeInTheDocument();
		expect(screen.getByText("prod · production")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
	});

	it("makes the name editable where the design owns it, as a named field", async () => {
		const onChange = vi.fn();
		render(
			<InspectorFrame
				eyebrow="Database"
				title="Database"
				name={{ value: "orders", onChange, placeholder: "name", mono: true }}
				summary="PostgreSQL"
				onClose={vi.fn()}
			>
				<p>body</p>
			</InspectorFrame>,
		);
		const name = screen.getByRole("textbox", { name: "Name" });
		expect(name).toHaveValue("orders");
		expect(name).toHaveAttribute("placeholder", "name");
		await userEvent.setup().type(name, "x");
		expect(onChange).toHaveBeenCalledWith("ordersx");
		expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
	});

	it("shows the state as one badge and one sentence", () => {
		render(
			<InspectorFrame
				title="orders"
				status={{ label: "Needs setup", tier: "idle", message: "Port is required" }}
				onClose={vi.fn()}
			>
				<p>body</p>
			</InspectorFrame>,
		);
		expect(screen.getByText("Needs setup")).toBeInTheDocument();
		expect(screen.getByText("Port is required")).toBeInTheDocument();
	});

	it("has one close control, and it calls onClose", async () => {
		const onClose = vi.fn();
		render(
			<InspectorFrame title="orders" onClose={onClose}>
				<p>body</p>
			</InspectorFrame>,
		);
		await userEvent.setup().click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("draws a tab bar only when the subject has more than one view", () => {
		const { rerender } = render(
			<InspectorFrame title="orders" tabs={["status"]} tab="status" onClose={vi.fn()}>
				<p>body</p>
			</InspectorFrame>,
		);
		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();

		rerender(
			<InspectorFrame
				title="orders"
				tabs={["configure", "connections", "status"]}
				tab="configure"
				onClose={vi.fn()}
			>
				<p>body</p>
			</InspectorFrame>,
		);
		expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
			"Settings",
			"Connections",
			"Status",
		]);
		expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("body")).toBeInTheDocument();
	});

	it("asks for another view by its id", async () => {
		const onTabChange = vi.fn();
		const user = userEvent.setup();
		render(
			<InspectorFrame
				title="orders"
				tabs={["configure", "status"]}
				tab="configure"
				onTabChange={onTabChange}
				onClose={vi.fn()}
			>
				<p>body</p>
			</InspectorFrame>,
		);
		await user.click(screen.getByRole("tab", { name: "Status" }));
		expect(onTabChange).toHaveBeenLastCalledWith("status");
	});

	it("names every tab the view store can ask for", () => {
		expect(INSPECTOR_TAB_LABEL).toEqual({
			configure: "Settings",
			connections: "Connections",
			status: "Status",
			sources: "Sources",
			activity: "Activity",
		});
	});

	it("says what is staged and what went wrong in ONE place, the error as an alert", () => {
		render(
			<InspectorFrame
				title="grafana"
				notice="Install staged."
				error="This add-on is not in the catalog."
				onClose={vi.fn()}
			>
				<p>body</p>
			</InspectorFrame>,
		);
		const messages = document.querySelector("[data-slot=inspector-messages]");
		expect(messages).not.toBeNull();
		expect(messages).toContainElement(screen.getByRole("status"));
		expect(messages).toContainElement(screen.getByRole("alert"));
		expect(screen.getByRole("status")).toHaveTextContent("Install staged.");
		expect(screen.getByRole("alert")).toHaveTextContent("This add-on is not in the catalog.");
	});

	it("draws no message place when there is nothing to say", () => {
		render(
			<InspectorFrame title="orders" onClose={vi.fn()}>
				<p>body</p>
			</InspectorFrame>,
		);
		expect(document.querySelector("[data-slot=inspector-messages]")).toBeNull();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("offers a way back only when the subject was reached from another one", async () => {
		const onClick = vi.fn();
		render(
			<InspectorFrame title="api-key" back={{ label: "Secrets", onClick }} onClose={vi.fn()}>
				<p>body</p>
			</InspectorFrame>,
		);
		await userEvent.setup().click(screen.getByRole("button", { name: "Secrets" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("has no commit button of its own: nothing is named Save, Install or Update", () => {
		render(
			<InspectorFrame
				title="orders"
				tabs={["configure", "status"]}
				tab="configure"
				status={{ label: "Ready", tier: "active" }}
				notice="Staged."
				onClose={vi.fn()}
			>
				<p>body</p>
			</InspectorFrame>,
		);
		const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
		expect(names).toEqual(["Close"]);
	});
});

describe("InspectorAction", () => {
	it("runs its action", async () => {
		const onClick = vi.fn();
		render(<InspectorAction label="Add to changes" onClick={onClick} />);
		await userEvent.setup().click(screen.getByRole("button", { name: "Add to changes" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("given a reason it stays focusable, says why, and does nothing", async () => {
		const onClick = vi.fn();
		const user = userEvent.setup();
		render(
			<InspectorAction
				label="Remove"
				onClick={onClick}
				disabledReason="This add-on is being removed."
			/>,
		);
		const button = screen.getByRole("button", { name: "Remove" });
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).toHaveAccessibleDescription("This add-on is being removed.");
		await user.tab();
		expect(button).toHaveFocus();
		await user.click(button);
		expect(onClick).not.toHaveBeenCalled();
	});
});
