// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the new-environment dialog says WHY a name was refused, under the name field.
//
// `addEnvironment` / `duplicateEnvironment` used to THROW their name refusals, and the dialog
// toasted `err.message`. In a production build a thrown server-action message is replaced by a
// digest, so the user was told nothing they could act on. The actions now RETURN
// `{ ok: false, error }`; this file pins the half the user sees: the sentence is rendered next to
// the field, the field is marked invalid and described by it, nothing is toasted, and the dialog
// stays open so the name can be retyped.
//
// Against the old dialog every case fails: it destructured `{ environment }` from the result, so a
// refusal value reached `onCreated(undefined.name)` and toasted a TypeError instead.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const addEnvironment = vi.fn();
const duplicateEnvironment = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/app/server/actions/projects", () => ({
	addEnvironment: (...a: unknown[]) => addEnvironment(...a),
	duplicateEnvironment: (...a: unknown[]) => duplicateEnvironment(...a),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));

import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";

const TAKEN = 'This project already has an environment named "staging". Choose another name.';

/** Renders the open dialog over one existing (default) environment. */
function renderIt(onCreated = vi.fn()) {
	const onOpenChange = vi.fn();
	render(
		<NewEnvironmentDialog
			open
			onOpenChange={onOpenChange}
			projectId="p1"
			envs={[{ id: "env-1", project_id: "p1", name: "production", is_default: true, stage: "production" }]}
			onCreated={onCreated}
		/>,
	);
	return { onCreated, onOpenChange };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("NewEnvironmentDialog — a refused name", () => {
	it("renders the server's sentence under the field, marks the field invalid, and stays open", async () => {
		duplicateEnvironment.mockResolvedValue({ ok: false, error: TAKEN });
		const user = userEvent.setup();
		const { onCreated, onOpenChange } = renderIt();

		const field = screen.getByLabelText("Environment name");
		await user.type(field, "Staging");
		await user.click(screen.getByRole("button", { name: "Create environment" }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(TAKEN);
		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(field).toHaveAttribute("aria-describedby", alert.id);
		expect(duplicateEnvironment).toHaveBeenCalledWith("p1", "env-1", "Staging");
		expect(toastError).not.toHaveBeenCalled();
		expect(onCreated).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("does the same on the Empty path, and clears the sentence once the name is edited", async () => {
		addEnvironment.mockResolvedValue({
			ok: false,
			error: 'Environment name "settings" is reserved by the console.',
		});
		const user = userEvent.setup();
		renderIt();

		const field = screen.getByLabelText("Environment name");
		await user.type(field, "settings");
		await user.click(screen.getByRole("button", { name: /empty environment/i }));
		await user.click(screen.getByRole("button", { name: "Create environment" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(/reserved by the console/);
		expect(addEnvironment).toHaveBeenCalledWith("p1", {
			name: "settings",
			stage: "development",
		});

		await user.type(field, "-2");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(field).not.toHaveAttribute("aria-invalid");
	});

	it("still creates and hands the new name back on success", async () => {
		duplicateEnvironment.mockResolvedValue({
			ok: true,
			environment: { id: "env-2", name: "staging" },
		});
		const user = userEvent.setup();
		const { onCreated } = renderIt();

		await user.type(screen.getByLabelText("Environment name"), "Staging");
		await user.click(screen.getByRole("button", { name: "Create environment" }));

		await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith("staging"));
		expect(toastSuccess).toHaveBeenCalledWith("Environment duplicated");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
