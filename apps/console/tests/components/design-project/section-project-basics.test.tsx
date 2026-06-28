// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionProjectBasics } from "@/components/design-project/section-project-basics";
import { renderWithForm } from "./test-utils";

describe("SectionProjectBasics", () => {
	it("renders section title", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByText("Project Basics").length).toBeGreaterThan(0);
	});

	it("renders project name input", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByPlaceholderText("my-project").length).toBeGreaterThan(0);
	});

	it("renders the environment selector", () => {
		renderWithForm(<SectionProjectBasics />);
		// A project picks only name + environment.
		expect(screen.getAllByText("Environment").length).toBeGreaterThan(0);
	});

	it("enforces lowercase on project name", () => {
		renderWithForm(<SectionProjectBasics />);
		const inputs = screen.getAllByPlaceholderText("my-project") as HTMLInputElement[];
		fireEvent.change(inputs[0], { target: { value: "MyProject" } });
		expect(inputs[0].value).toBe("myproject");
	});

	it("shows character counter when typing", () => {
		renderWithForm(<SectionProjectBasics />);
		const inputs = screen.getAllByPlaceholderText("my-project");
		fireEvent.change(inputs[0], { target: { value: "test" } });
		expect(screen.getAllByText("4/25").length).toBeGreaterThan(0);
	});

	it("marks required fields with an asterisk", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByText("*").length).toBeGreaterThan(0);
	});
});
