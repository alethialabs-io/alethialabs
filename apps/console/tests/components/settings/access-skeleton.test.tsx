// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6320 (B2): both Access routes' skeletons draw the page's lead block and its body in the page's
// own boxes, for each of the two shapes the entitlement decides (#6250).
//
// - The lead is the inheritance note: a `p-4` bordered box around ONE line of copy. It used to be a
//   74px filled box — 20px taller than the note, and tall enough to count as a block, which the
//   audit then matched against the upsell panel below it.
// - The un-entitled body is the upsell panel (`FeatureUpsell`, an `EmptyState`). It used to be a
//   flat 260px box against the panel's ~319px.
// - The project route had no skeleton of its own and fell back to the project settings' generic one.

import { act, render } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ customRoles: false }));

vi.mock("@/lib/authz/guard", () => ({ currentActor: async () => ({ userId: "u1", orgId: "o1" }) }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ customRoles: h.customRoles }) }));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({ useUpgradeSheet: () => ({ openUpgrade: vi.fn() }) }));

import OrgAccessLoading from "@/app/(private)/[org]/~/settings/access/loading";
import ProjectAccessLoading from "@/app/(private)/[org]/[project]/settings/access/loading";
import { PeopleListSkeleton, PeopleUpsellSkeleton } from "@/components/settings/members/people-skeleton";
import { AccessRouteSkeleton } from "@/components/settings/members/people-route-skeletons";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/** The props a route skeleton rendered its people skeleton with. */
function propsOf(node: ReactNode): Record<string, unknown> {
	if (!isValidElement<Record<string, unknown>>(node)) throw new Error("not an element");
	return node.props;
}

/** The class tokens of an element. */
function classes(el: Element | null | undefined): string[] {
	return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("the Access routes' skeletons (#6320, B2)", () => {
	it("project: the list's shape with the entitlement, the note and the upsell without it", async () => {
		h.customRoles = true;
		const entitled = await ProjectAccessLoading();
		expect(isValidElement(entitled) && entitled.type === PeopleListSkeleton).toBe(true);
		expect(propsOf(entitled)).toMatchObject({ lead: true, facets: 2, columns: 6 });

		h.customRoles = false;
		const gated = await ProjectAccessLoading();
		expect(isValidElement(gated) && gated.type === PeopleUpsellSkeleton).toBe(true);
		expect(propsOf(gated)).toMatchObject({ lead: true, toolbar: false });
	});

	// The org route's loading state is SYNCHRONOUS (CON-M4): it renders `AccessRouteSkeleton`, which
	// keys on the workspace store's plan and draws the entitled shape while that is not yet known.
	it("org: a synchronous loading state that draws the store's answer", () => {
		const node = OrgAccessLoading();
		expect(isValidElement(node) && node.type === AccessRouteSkeleton).toBe(true);

		const shape = (customRoles: boolean | null) => {
			act(() =>
				useWorkspaceStore.setState({
					entitlements: customRoles === null ? null : { ...COMMUNITY_ENTITLEMENTS, customRoles },
				}),
			);
			const { container, unmount } = render(<AccessRouteSkeleton />);
			const table = container.querySelector("table, [data-slot='data-table-skeleton']") !== null;
			const upsell = container.querySelector(".border-dashed") !== null;
			unmount();
			return { table, upsell };
		};
		expect(shape(false).upsell).toBe(true);
		const entitled = shape(true);
		expect(entitled.upsell).toBe(false);
		expect(entitled.table).toBe(true);
		expect(shape(null).upsell).toBe(false);
	});

	it("draws the lead as the note's box around one line, not a 74px block", () => {
		const { container } = render(<PeopleUpsellSkeleton lead toolbar={false} />);
		const note = container.firstElementChild?.firstElementChild;
		expect(classes(note)).toEqual(expect.arrayContaining(["mb-[18px]", "flex", "gap-3", "rounded-lg", "border", "p-4"]));
		expect(container.querySelector(".h-\\[74px\\]")).toBeNull();
		// The icon, then one line box.
		expect(note?.children).toHaveLength(2);
		expect(classes(note?.children[1])).toContain("h-[1lh]");
	});

	it("draws the upsell in the upsell panel's own frame", () => {
		const real = render(<FeatureUpsell feature="access" />).container.firstElementChild;
		const { container } = render(<PeopleUpsellSkeleton toolbar={false} />);
		const panel = container.firstElementChild?.firstElementChild;
		expect(container.querySelector(".h-\\[260px\\]")).toBeNull();
		// The frame's box model — the padding at both widths, the gap, the centring, the dashed border.
		for (const token of ["flex", "flex-col", "items-center", "justify-center", "gap-6", "p-6", "md:p-12", "rounded-lg", "border", "border-dashed"]) {
			expect(classes(real), `the real panel carries ${token}`).toContain(token);
			expect(classes(panel), `the skeleton panel carries ${token}`).toContain(token);
		}
		// Header (icon, title, copy) and the action row, as the panel has them.
		expect(panel?.children).toHaveLength(real?.children.length ?? -1);
	});
});
