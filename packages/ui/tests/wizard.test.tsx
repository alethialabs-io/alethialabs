// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The wizard primitives (src/wizard.tsx). Each test asserts one of the things the file's header
// says a piece guarantees: what a screen reader is told, which items can be pressed, that the
// footer's row does not move, that "next" and "submit" are different nodes whose click is
// cancelled, and when the disclosure and the step heading open, focus and announce.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
	Stepper,
	type StepperItem,
	WizardDisclosure,
	WizardFooter,
	type WizardFooterProps,
	WizardFormError,
	WizardRestoredNotice,
	WizardStepHeading,
} from "../src/wizard";

const ITEMS: readonly StepperItem[] = [
	{ id: "cloud", label: "Cloud", state: "done" },
	{ id: "placement", label: "Placement", state: "invalid" },
	{ id: "capacity", label: "Capacity", state: "current" },
	{ id: "review", label: "Review", state: "todo" },
];

describe("Stepper", () => {
	it("is a named nav holding an ordered list, one item per step", () => {
		render(<Stepper label="Add a warm pool" items={ITEMS} />);
		const nav = screen.getByRole("navigation", { name: "Add a warm pool" });
		const list = within(nav).getByRole("list");
		expect(list.tagName).toBe("OL");
		expect(within(list).getAllByRole("listitem")).toHaveLength(4);
	});

	it("marks only the current step with aria-current", () => {
		render(<Stepper label="Steps" items={ITEMS} />);
		const current = screen.getAllByRole("listitem").filter((item) => item.hasAttribute("aria-current"));
		expect(current).toHaveLength(1);
		expect(current[0]).toHaveAttribute("aria-current", "step");
		expect(current[0]).toHaveTextContent("Capacity");
	});

	it("says each step's state in text, not by its marker alone", () => {
		render(<Stepper label="Steps" items={ITEMS} />);
		const [cloud, placement, capacity, review] = screen.getAllByRole("listitem");
		expect(cloud).toHaveTextContent("Completed");
		expect(placement).toHaveTextContent("Needs attention");
		expect(capacity).toHaveTextContent("Current step");
		expect(review).toHaveTextContent("Not started");
	});

	it("numbers the steps that have no icon, and hides every marker from a screen reader", () => {
		render(<Stepper label="Steps" items={ITEMS} />);
		const [cloud, , capacity, review] = screen.getAllByRole("listitem");
		for (const item of [cloud, capacity, review]) {
			expect(item?.querySelector('[data-slot="stepper-marker"]')).toHaveAttribute("aria-hidden", "true");
		}
		expect(capacity?.querySelector('[data-slot="stepper-marker"]')).toHaveTextContent("3");
		expect(review?.querySelector('[data-slot="stepper-marker"]')).toHaveTextContent("4");
		expect(cloud?.querySelector('[data-slot="stepper-marker"]')?.textContent).toBe("");
	});

	it("makes completed and invalid steps buttons, and nothing else", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<Stepper label="Steps" items={ITEMS} onSelect={onSelect} />);
		const buttons = screen.getAllByRole("button");
		expect(buttons.map((button) => button.textContent)).toEqual([
			"CloudCompleted",
			"PlacementNeeds attention",
		]);
		await user.click(screen.getByRole("button", { name: /Placement/ }));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("placement");
	});

	it("has no buttons at all without onSelect", () => {
		render(<Stepper label="Steps" items={ITEMS} />);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});

describe("WizardFooter", () => {
	const next: WizardFooterProps["primary"] = { kind: "next", label: "Next", onPress: () => {} };

	it("keeps Back's slot when there is no Back, so the row does not move", () => {
		const { container, rerender } = render(<WizardFooter back={null} primary={next} pending={false} />);
		const slot = container.querySelector('[data-slot="wizard-footer-back"]');
		expect(slot).toBeInTheDocument();
		expect(slot).toBeEmptyDOMElement();
		expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

		rerender(<WizardFooter back={() => {}} primary={next} pending={false} />);
		expect(container.querySelector('[data-slot="wizard-footer-back"]')).toBe(slot);
		expect(screen.getByRole("button", { name: "Back" }).parentElement).toBe(slot);
	});

	it("calls back and the primary handler", async () => {
		const user = userEvent.setup();
		const back = vi.fn();
		const onPress = vi.fn();
		render(<WizardFooter back={back} primary={{ kind: "next", label: "Next", onPress }} pending={false} />);
		await user.click(screen.getByRole("button", { name: "Back" }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(back).toHaveBeenCalledTimes(1);
		expect(onPress).toHaveBeenCalledTimes(1);
	});

	it("never submits a form, and cancels the click before calling the handler", () => {
		const onSubmit = vi.fn();
		const seen: boolean[] = [];
		render(
			<form onSubmit={onSubmit} onClick={(event) => seen.push(event.defaultPrevented)}>
				<WizardFooter
					back={null}
					primary={{ kind: "submit", label: "Create pool", onPress: () => {} }}
					pending={false}
				/>
			</form>,
		);
		const button = screen.getByRole("button", { name: "Create pool" });
		expect(button).toHaveAttribute("type", "button");
		fireEvent.click(button);
		expect(seen).toEqual([true]);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("mounts a different node for submit than for next", () => {
		const { rerender } = render(<WizardFooter back={null} primary={next} pending={false} />);
		const nextButton = screen.getByRole("button", { name: "Next" });
		expect(nextButton).toHaveAttribute("data-kind", "next");
		rerender(
			<WizardFooter
				back={null}
				primary={{ kind: "submit", label: "Create pool", onPress: () => {} }}
				pending={false}
			/>,
		);
		const submitButton = screen.getByRole("button", { name: "Create pool" });
		expect(submitButton).toHaveAttribute("data-kind", "submit");
		expect(submitButton).not.toBe(nextButton);
		expect(nextButton).not.toBeInTheDocument();
	});

	it("keeps the same node while only the label changes", () => {
		const { rerender } = render(<WizardFooter back={null} primary={next} pending={false} />);
		const before = screen.getByRole("button", { name: "Next" });
		rerender(
			<WizardFooter back={null} primary={{ kind: "next", label: "Continue", onPress: () => {} }} pending={false} />,
		);
		expect(screen.getByRole("button", { name: "Continue" })).toBe(before);
	});

	it("disables both buttons and shows a spinner while pending", () => {
		const onPress = vi.fn();
		render(
			<WizardFooter back={() => {}} primary={{ kind: "submit", label: "Create pool", onPress }} pending />,
		);
		expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
		const primary = screen.getByRole("button", { name: /Create pool/ });
		expect(primary).toBeDisabled();
		expect(within(primary).getByRole("status", { name: "Loading" })).toBeInTheDocument();
		fireEvent.click(primary);
		expect(onPress).not.toHaveBeenCalled();
	});

	it("disables the primary action with a reason a screen reader is given", () => {
		const onPress = vi.fn();
		render(
			<WizardFooter
				back={null}
				primary={{ kind: "submit", label: "Create project", onPress }}
				pending={false}
				disabledReason="The repository scan is still running"
			/>,
		);
		const primary = screen.getByRole("button", { name: "Create project" });
		expect(primary).toBeDisabled();
		expect(primary).toHaveAccessibleDescription("The repository scan is still running");
		fireEvent.click(primary);
		expect(onPress).not.toHaveBeenCalled();
	});
});

describe("WizardDisclosure", () => {
	/** A disclosure with one input inside. */
	function Advanced({ forceOpen }: { forceOpen: boolean }) {
		return (
			<WizardDisclosure label="Advanced scaling" forceOpen={forceOpen}>
				<label>
					Rollout surge
					<input />
				</label>
			</WizardDisclosure>
		);
	}

	/** The disclosure's panel. */
	function panel(container: HTMLElement): HTMLElement {
		const found = container.querySelector<HTMLElement>('[data-slot="wizard-disclosure-panel"]');
		if (found === null) throw new Error("the disclosure has no panel");
		return found;
	}

	it("starts closed, with its content mounted and hidden", () => {
		const { container } = render(<Advanced forceOpen={false} />);
		const toggle = screen.getByRole("button", { name: "Advanced scaling" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(toggle).toHaveAttribute("aria-controls", panel(container).id);
		expect(panel(container)).not.toBeVisible();
		expect(container.querySelector("input")).toBeInTheDocument();
	});

	it("opens and closes on the toggle", async () => {
		const user = userEvent.setup();
		const { container } = render(<Advanced forceOpen={false} />);
		const toggle = screen.getByRole("button", { name: "Advanced scaling" });
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(panel(container)).toBeVisible();
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(panel(container)).not.toBeVisible();
	});

	it("is open while forced, and the toggle cannot close it", async () => {
		const user = userEvent.setup();
		const { container } = render(<Advanced forceOpen />);
		const toggle = screen.getByRole("button", { name: "Advanced scaling" });
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(panel(container)).toBeVisible();
		await user.click(toggle);
		expect(panel(container)).toBeVisible();
	});

	it("closes again when it is no longer forced and the user never went inside", () => {
		const { container, rerender } = render(<Advanced forceOpen />);
		rerender(<Advanced forceOpen={false} />);
		expect(panel(container)).not.toBeVisible();
	});

	it("stays open after the error clears once focus has been inside", () => {
		const { container, rerender } = render(<Advanced forceOpen />);
		fireEvent.focusIn(screen.getByLabelText("Rollout surge"));
		rerender(<Advanced forceOpen={false} />);
		expect(panel(container)).toBeVisible();
		expect(screen.getByRole("button", { name: "Advanced scaling" })).toHaveAttribute("aria-expanded", "true");
	});
});

describe("WizardStepHeading", () => {
	it("renders the step's name as a heading with its description", () => {
		render(<WizardStepHeading title="Capacity" position={3} total={5} description="How many runners" level={3} />);
		expect(screen.getByRole("heading", { level: 3, name: "Capacity" })).toBeInTheDocument();
		expect(screen.getByText("How many runners")).toBeInTheDocument();
	});

	it("has a polite live region saying the position", () => {
		render(<WizardStepHeading title="Placement" position={2} total={5} />);
		const status = screen.getByRole("status");
		expect(status).toHaveAttribute("aria-live", "polite");
		expect(status).toHaveTextContent("Step 2 of 5: Placement");
	});

	it("does not take focus on first paint", () => {
		render(<WizardStepHeading title="Cloud" position={1} total={5} />);
		expect(document.body).toHaveFocus();
	});

	it("takes focus and announces when the step changes", async () => {
		const { container, rerender } = render(<WizardStepHeading title="Cloud" position={1} total={5} />);
		rerender(<WizardStepHeading title="Placement" position={2} total={5} />);
		const heading = container.querySelector<HTMLElement>('[data-slot="section-heading"]');
		await waitFor(() => expect(heading).toHaveFocus());
		expect(heading).toHaveAttribute("tabindex", "-1");
		expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 5: Placement");
	});

	it("does not move focus when it re-renders on the same step", () => {
		const { rerender } = render(<WizardStepHeading title="Cloud" position={1} total={5} />);
		rerender(<WizardStepHeading title="Cloud" position={1} total={5} description="Now with a description" />);
		expect(document.body).toHaveFocus();
	});
});

describe("WizardRestoredNotice", () => {
	it("says the draft was restored and offers to start over", async () => {
		const user = userEvent.setup();
		const onStartOver = vi.fn();
		render(<WizardRestoredNotice onStartOver={onStartOver} />);
		expect(screen.getByRole("status")).toHaveTextContent("Restored your draft · Start over");
		await user.click(screen.getByRole("button", { name: "Start over" }));
		expect(onStartOver).toHaveBeenCalledTimes(1);
	});
});

describe("WizardFormError", () => {
	it("announces a message as an alert", () => {
		render(<WizardFormError message="Your plan allows two pools" />);
		expect(screen.getByRole("alert")).toHaveTextContent("Your plan allows two pools");
	});

	it("renders nothing without one", () => {
		const { container } = render(<WizardFormError message={null} />);
		expect(container).toBeEmptyDOMElement();
	});
});
