// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "Deploy without approval" picker (AGT-L2 design §4) in every state the design lists: editable,
// production rows shown and disabled with their reason, disabled until Deploy is ticked, read-only
// without `org:manage_agents`, no project chosen, loading, failed, and the hint that rewrites itself.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AutoApprovePicker, type PickerChoices } from "@/components/settings/tokens/auto-approve-picker";

const PROJECTS: PickerChoices = {
	state: "ready",
	projects: [
		{
			projectId: "p-pay",
			projectName: "payments-api",
			environments: [
				{ id: "e-pay-dev", name: "dev", stage: "development" },
				{ id: "e-pay-staging", name: "staging", stage: "staging" },
				{ id: "e-pay-prod", name: "production", stage: "production" },
			],
		},
		{
			projectId: "p-web",
			projectName: "web",
			environments: [
				{ id: "e-web-staging", name: "staging", stage: "staging" },
				{ id: "e-web-prod", name: "production", stage: "production" },
			],
		},
	],
};

/** A controlled picker, so ticking really changes what it shows. */
function Harness(props: { canDeploy?: boolean; canManageAgents?: boolean; initial?: string[]; choices?: PickerChoices; onChange?: (v: string[]) => void }) {
	const [value, setValue] = useState<string[]>(props.initial ?? []);
	return (
		<AutoApprovePicker
			choices={props.choices ?? PROJECTS}
			value={value}
			onChange={(next) => {
				setValue(next);
				props.onChange?.(next);
			}}
			canDeploy={props.canDeploy ?? true}
			canManageAgents={props.canManageAgents ?? true}
		/>
	);
}

describe("AutoApprovePicker", () => {
	it("is a fieldset with its legend, grouping environments by project", () => {
		render(<Harness />);
		const group = screen.getByRole("group", { name: "Deploy without approval" });
		expect(within(group).getByRole("list", { name: "payments-api environments" })).toBeInTheDocument();
		expect(within(group).getByRole("list", { name: "web environments" })).toBeInTheDocument();
		// Each checkbox names its environment AND its project, since "staging" alone is ambiguous.
		expect(screen.getByRole("checkbox", { name: "staging payments-api" })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "staging web" })).toBeInTheDocument();
	});

	it("shows production rows, disabled, with the reason tied to the checkbox", () => {
		render(<Harness />);
		const prod = screen.getByRole("checkbox", { name: "production payments-api" });
		expect(prod).toHaveAttribute("aria-disabled", "true");
		expect(prod).toHaveAccessibleDescription("Production always needs a person.");
		expect(document.querySelectorAll('[data-stage="production"]')).toHaveLength(2);
	});

	it("rewrites a row's hint when it is ticked, and reports the choice", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		const staging = screen.getByRole("checkbox", { name: "staging web" });
		expect(staging).toHaveAccessibleDescription("Each deploy waits for a person.");
		fireEvent.click(staging);
		expect(onChange).toHaveBeenLastCalledWith(["e-web-staging"]);
		expect(screen.getByRole("checkbox", { name: "staging web" })).toHaveAccessibleDescription(
			"Deploys go ahead without asking anyone.",
		);
	});

	it("is disabled until the token can Deploy, and says why", () => {
		render(<Harness canDeploy={false} />);
		expect(screen.getByText("Needs the Deploy permission")).toBeInTheDocument();
		expect(screen.getByText("Turn on Deploy above to choose environments.")).toBeInTheDocument();
		for (const box of screen.getAllByRole("checkbox")) expect(box).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("group", { name: "Deploy without approval" })).toHaveAccessibleDescription(
			/Needs the Deploy permission/,
		);
	});

	it("is read-only without org:manage_agents, keeping the current choice visible", () => {
		render(<Harness canManageAgents={false} initial={["e-web-staging"]} />);
		expect(screen.getByText("You can't choose these environments")).toBeInTheDocument();
		expect(screen.getByText(/needs the Manage agents permission/)).toBeInTheDocument();
		const staging = screen.getByRole("checkbox", { name: "staging web" });
		expect(staging).toHaveAttribute("aria-checked", "true");
		expect(staging).toHaveAttribute("aria-disabled", "true");
		// Nothing about Deploy is shown: the permission is the one thing in the way.
		expect(screen.queryByText("Needs the Deploy permission")).toBeNull();
	});

	it("never ticks production, even if the value names it", () => {
		render(<Harness initial={["e-web-prod"]} />);
		expect(screen.getByRole("checkbox", { name: "production web" })).toHaveAttribute("aria-checked", "false");
	});

	it("asks for a project first when the token is limited to none", () => {
		render(
			<AutoApprovePicker choices={PROJECTS} value={[]} onChange={vi.fn()} canDeploy canManageAgents noProjectChosen />,
		);
		expect(screen.getByText("Choose at least one project first.")).toBeInTheDocument();
		expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
	});

	it("shows a loading state, then a failure with a retry", () => {
		const { rerender } = render(
			<AutoApprovePicker choices={{ state: "loading" }} value={[]} onChange={vi.fn()} canDeploy canManageAgents />,
		);
		expect(screen.getByLabelText("Loading environments")).toHaveAttribute("aria-busy", "true");
		const retry = vi.fn();
		rerender(
			<AutoApprovePicker choices={{ state: "error", retry }} value={[]} onChange={vi.fn()} canDeploy canManageAgents />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalledOnce();
	});

	it("always states the three rules that hold whatever is chosen", () => {
		render(<Harness />);
		expect(screen.getByText("Production environments always need a person.")).toBeInTheDocument();
		expect(screen.getByText("Destroys always need a person, everywhere.")).toBeInTheDocument();
		expect(screen.getByText("Every automatic deploy is recorded in Activity with this token's name.")).toBeInTheDocument();
	});
});
