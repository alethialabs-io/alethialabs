import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionDatabases } from "@/components/plant-vine/section-databases";
import { renderWithForm } from "./test-utils";

describe("SectionDatabases", () => {
	it("renders empty state", () => {
		renderWithForm(<SectionDatabases />);
		expect(screen.getAllByText("No databases configured.").length).toBeGreaterThan(0);
	});

	it("adds database on button click", () => {
		renderWithForm(<SectionDatabases />);
		const buttons = screen.getAllByText("Add Database");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByText("primary").length).toBeGreaterThan(0);
	});

	it("shows IAM auth toggle after adding", () => {
		renderWithForm(<SectionDatabases />);
		const buttons = screen.getAllByText("Add Database");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByText("IAM Authentication").length).toBeGreaterThan(0);
	});

	it("shows engine selector", () => {
		renderWithForm(<SectionDatabases />);
		const buttons = screen.getAllByText("Add Database");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByText("Engine").length).toBeGreaterThan(0);
	});

	it("shows ACU inputs", () => {
		renderWithForm(<SectionDatabases />);
		const buttons = screen.getAllByText("Add Database");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByText("Min ACU").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Max ACU").length).toBeGreaterThan(0);
	});
});
