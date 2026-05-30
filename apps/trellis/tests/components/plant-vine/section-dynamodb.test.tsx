import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionDynamodb } from "@/components/plant-vine/section-dynamodb";
import { renderWithForm } from "./test-utils";

describe("SectionDynamodb", () => {
	it("renders empty state", () => {
		renderWithForm(<SectionDynamodb />);
		expect(screen.getAllByText("No DynamoDB tables configured.").length).toBeGreaterThan(0);
	});

	it("adds table on button click", () => {
		renderWithForm(<SectionDynamodb />);
		const buttons = screen.getAllByText("Add Table");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByPlaceholderText("id").length).toBeGreaterThan(0);
	});

	it("shows hash key input after adding", () => {
		renderWithForm(<SectionDynamodb />);
		const buttons = screen.getAllByText("Add Table");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByPlaceholderText("id").length).toBeGreaterThan(0);
	});

	it("has advanced options text", () => {
		renderWithForm(<SectionDynamodb />);
		const buttons = screen.getAllByText("Add Table");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByText("Advanced options").length).toBeGreaterThan(0);
	});
});
