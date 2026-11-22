// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6843 (RUBRIC B2, B-29): the `/~/new` skeleton is the one screen's shape, drawn from the screen's
// own parts, and the route's `loading.tsx` draws it without waiting on any read.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/addons/byo-flag", () => ({ isByoHelmEnabled: () => true }));
vi.mock("@/lib/addons/byo-iac-flag", () => ({ isByoIacEnabled: () => false }));

const { CreateProjectFormSkeleton } = await import("@/components/create-project/create-project-skeletons");
const { sourceOptions } = await import("@/components/create-project/source-options");
const { default: NewProjectLoading } = await import("@/app/(private)/[org]/~/new/loading");

const FLAGS = [
	{ byoHelmEnabled: false, byoIacEnabled: false },
	{ byoHelmEnabled: true, byoIacEnabled: false },
	{ byoHelmEnabled: false, byoIacEnabled: true },
	{ byoHelmEnabled: true, byoIacEnabled: true },
];

describe("CreateProjectFormSkeleton", () => {
	it("draws one box per starting point the screen offers, with each option's own copy, in order", () => {
		for (const flags of FLAGS) {
			const { container, unmount } = render(<CreateProjectFormSkeleton {...flags} />);
			const boxes = [...container.querySelectorAll('[data-slot="source-option-skeleton"]')];
			expect(boxes.map((box) => box.textContent)).toEqual(
				sourceOptions(flags).map((option) => `${option.title}${option.description}`),
			);
			unmount();
		}
	});

	it("labels the same rows the form has", () => {
		render(<CreateProjectFormSkeleton byoHelmEnabled={false} byoIacEnabled={false} />);
		const root = screen.getByTestId("create-project-form-skeleton");
		for (const label of ["Start from", "Cloud", "Region", "Project name"]) {
			expect(within(root).getByText(label)).toBeInTheDocument();
		}
		expect(root).toHaveAttribute("aria-busy", "true");
	});
});

describe("the route's loading.tsx", () => {
	it("is synchronous: it returns the skeleton, not a promise", () => {
		const element = NewProjectLoading();
		expect(element).not.toBeInstanceOf(Promise);
		const { container } = render(element);
		// The flags reach it: BYO Helm on, BYO IaC off.
		expect(container.querySelectorAll('[data-slot="source-option-skeleton"]')).toHaveLength(
			sourceOptions({ byoHelmEnabled: true, byoIacEnabled: false }).length,
		);
	});
});
