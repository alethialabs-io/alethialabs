import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { SectionSecrets } from "@/components/plant-vine/section-secrets";
import { renderWithForm } from "./test-utils";

describe("SectionSecrets", () => {
	it("renders empty state", () => {
		renderWithForm(<SectionSecrets />);
		expect(screen.getAllByText("No secrets configured.").length).toBeGreaterThan(0);
	});

	it("shows preset dropdown text", () => {
		renderWithForm(<SectionSecrets />);
		expect(screen.getAllByText("Add secret...").length).toBeGreaterThan(0);
	});

	it("renders section title", () => {
		renderWithForm(<SectionSecrets />);
		expect(screen.getAllByText("Secrets").length).toBeGreaterThan(0);
	});

	it("shows description", () => {
		renderWithForm(<SectionSecrets />);
		expect(screen.getAllByText(/Auto-generated passwords/i).length).toBeGreaterThan(0);
	});
});
