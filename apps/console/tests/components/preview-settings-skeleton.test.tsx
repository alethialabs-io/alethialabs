// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6335 (RUBRIC B2): the Preview environments skeleton draws the Source row the viewer will get.
// That row is the repo picker's "No Git accounts linked" panel or its provider and repository row,
// and the two share no geometry. The route reads the viewer's linked providers before it draws, and
// `linkedFromProviders` turns that answer into the one bit the skeleton needs.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/client", () => ({ authClient: { linkSocial: vi.fn() } }));
vi.mock("@/app/server/actions/identities", () => ({ getLinkedProviders: vi.fn() }));
vi.mock("@/app/server/actions/git/repositories", () => ({ fetchRepositoriesByProvider: vi.fn() }));
vi.mock("@/components/design-project/repository-context", () => ({
	useRepositoryContext: () => null,
}));

const { PreviewSettingsSkeleton, linkedFromProviders } = await import(
	"@/components/settings/preview/preview-settings-skeleton"
);

describe("linkedFromProviders", () => {
	it("is false for none linked, true for any, and unknown without an answer", () => {
		expect(linkedFromProviders([])).toBe(false);
		expect(linkedFromProviders(["gitlab"])).toBe(true);
		expect(linkedFromProviders(undefined)).toBeUndefined();
	});
});

describe("PreviewSettingsSkeleton — the Source row the viewer will get", () => {
	it("nothing linked: the Link panel's shape, not the row", () => {
		const { container } = render(<PreviewSettingsSkeleton linked={false} />);
		expect(container.querySelector('[data-slot="git-accounts-skeleton"]')).not.toBeNull();
		expect(container.querySelector('[data-slot="repository-row-skeleton"]')).toBeNull();
	});

	it("a provider linked, or no answer: the row's shape, not the panel", () => {
		for (const linked of [true, undefined]) {
			const { container, unmount } = render(<PreviewSettingsSkeleton linked={linked} />);
			expect(container.querySelector('[data-slot="repository-row-skeleton"]')).not.toBeNull();
			expect(container.querySelector('[data-slot="git-accounts-skeleton"]')).toBeNull();
			unmount();
		}
	});

	it("the panel's skeleton carries a bar for each Link button the panel draws", () => {
		const { container } = render(<PreviewSettingsSkeleton linked={false} />);
		const panel = container.querySelector('[data-slot="git-accounts-skeleton"]');
		// Three Link buttons and the manual-entry link: four 32px controls, as the panel draws them.
		expect(panel?.querySelectorAll('[data-slot="skeleton"].h-8')).toHaveLength(4);
	});
});
