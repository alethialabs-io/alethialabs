// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6335 (RUBRIC B2): the Environments skeleton draws the page a project has until it gets a second
// environment: one card and the dashed "Only one environment" note. It drew two cards. On the
// one-environment project every project starts as, the second card stood where the note and the
// consistency matrix land, 165px off (score 0.027 against the 0.02 budget).

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EnvironmentsSkeleton } from "@/components/environments/environments-skeleton";

describe("EnvironmentsSkeleton — the one-environment page", () => {
	it("draws ONE environment card, then the single-environment note", () => {
		const { container } = render(<EnvironmentsSkeleton />);
		const cards = container.querySelectorAll('[data-slot="environment-card-skeleton"]');
		expect(cards).toHaveLength(1);
		const note = container.querySelector('[data-slot="single-environment-note-skeleton"]');
		expect(note).not.toBeNull();
		// The note follows the card, as the page puts it under the list.
		expect(cards[0].compareDocumentPosition(note as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("reserves the card's Classify button at its real height (a `size=\"sm\"` button, 32px)", () => {
		const { container } = render(<EnvironmentsSkeleton />);
		const card = container.querySelector('[data-slot="environment-card-skeleton"]');
		expect(card?.querySelector('[data-slot="skeleton"].h-8.w-24')).not.toBeNull();
	});
});
