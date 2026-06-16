// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionProjectBasics } from "@/components/plant-vine/section-project-basics";
import { renderWithForm } from "./test-utils";

vi.mock("@/components/vineyards/vineyard-selector", () => ({
	VineyardSelector: ({ value, onChange }: any) => (
		<select data-testid="vineyard-selector" value={value || ""} onChange={(e) => onChange(e.target.value)}>
			<option value="">Select vineyard</option>
			<option value="test-id">Test Vineyard</option>
		</select>
	),
}));

describe("SectionProjectBasics", () => {
	it("renders section title", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByText("Project Basics").length).toBeGreaterThan(0);
	});

	it("renders project name input", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByPlaceholderText("my-project").length).toBeGreaterThan(0);
	});

	it("renders vineyard selector", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByTestId("vineyard-selector").length).toBeGreaterThan(0);
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

	it("marks vineyard as required with asterisk", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByText("*").length).toBeGreaterThan(0);
	});
});
