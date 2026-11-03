// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6353 (RUBRIC B2): the `/~/settings/roles` skeleton is the page's shape. The gate measured its
// rail at 339px against the 701px the page stretches it to, and the whole master/detail 4px low.
// The page opens on the first built-in role — every permission granted, every group of the matrix
// open — and the skeleton's detail panel was six bars; its search bar was 32px over a 36px field.
// The skeleton now draws the page's own parts (`roles-parts.ts`): the same frames, the same role,
// the same open groups and rows. These tests pin that structure; the pixels are the gate's.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import RolesLoading from "@/app/(private)/[org]/~/settings/roles/loading";
import { PermissionMatrix } from "@/components/settings/roles/permission-matrix";
import {
	firstBuiltInRole,
	GROUP_CLASS,
	PERMISSION_ROW_CLASS,
	ROLES_GRID_CLASS,
} from "@/components/settings/roles/roles-parts";
import { RolesSkeleton } from "@/components/settings/roles/roles-skeleton";
import { BUILT_IN_ROLE_LABELS, BUILT_IN_ROLE_NAMES, PERMISSIONS } from "@/lib/authz/registry";
import { FilterSearch } from "@repo/ui/filter-search";

/** The `h-*` token of an element's class list — the one thing a placeholder's height is set by. */
function heightToken(el: Element | null): string | undefined {
	return el?.className.split(/\s+/).find((c) => /^h-/.test(c));
}

/** All elements in `root` matching `selector`. */
function all(root: ParentNode, selector: string): Element[] {
	return Array.from(root.querySelectorAll(selector));
}

describe("RolesSkeleton — the page's own parts", () => {
	it("is what the route's loading state renders", () => {
		const { container } = render(<RolesLoading />);
		expect(container.querySelector('[data-slot="roles-skeleton"]')).not.toBeNull();
	});

	it("draws the master/detail in the page's grid: a rail beside a detail panel", () => {
		const { container } = render(<RolesSkeleton />);
		const grid = container.querySelector('[data-slot="roles-skeleton-grid"]');
		expect(grid?.className).toBe(ROLES_GRID_CLASS);
		const columns = Array.from(grid?.children ?? []).map((c) => c.getAttribute("data-slot"));
		expect(columns).toEqual(["roles-skeleton-rail", "roles-skeleton-detail"]);
	});

	it("the search placeholder is as tall as the search field it stands in for", () => {
		const { container } = render(<RolesSkeleton />);
		const field = render(<FilterSearch value="" onChange={() => {}} />).container.firstElementChild;
		const fieldHeight = heightToken(field);
		expect(fieldHeight).toBeDefined();
		// The filter bar's first placeholder is the search box's.
		const bar = container.querySelector('[data-slot="roles-skeleton-filter-bar"]');
		expect(heightToken(bar?.firstElementChild ?? null)).toBe(fieldHeight);
	});

	it("lists every built-in role in the rail, in the console's order", () => {
		const { container } = render(<RolesSkeleton />);
		const rows = all(container, '[data-slot="roles-skeleton-rail-row"]').map((r) =>
			r.textContent?.replace(/\d+/g, "").trim(),
		);
		expect(rows).toEqual(BUILT_IN_ROLE_NAMES.map((n) => BUILT_IN_ROLE_LABELS[n]));
	});

	it("opens on the role the page opens on: the first built-in, with its description", () => {
		const role = firstBuiltInRole();
		expect(role.label).toBe(BUILT_IN_ROLE_LABELS[BUILT_IN_ROLE_NAMES[0]]);
		const { container } = render(<RolesSkeleton />);
		const header = container.querySelector('[data-slot="roles-skeleton-detail-header"]');
		expect(header?.textContent).toContain(role.label);
		expect(header?.textContent).toContain(role.description);
	});

	it("draws the matrix the page draws for that role: the same groups, open where it opens them, the same rows", () => {
		const role = firstBuiltInRole();
		const page = render(<PermissionMatrix value={role.permissionKeys} readOnly />).container;
		const skeleton = render(<RolesSkeleton />).container;

		const pageGroups = all(page, '[data-slot="collapsible"]');
		const skeletonGroups = all(skeleton, '[data-slot="roles-skeleton-group"]');
		expect(skeletonGroups).toHaveLength(pageGroups.length);
		// Each group in the same frame, and open exactly where the page's is.
		for (const [i, g] of skeletonGroups.entries()) {
			expect(g.className).toBe(GROUP_CLASS);
			expect(pageGroups[i]?.className).toBe(GROUP_CLASS);
			const pageOpen = pageGroups[i]?.querySelector('[data-slot="collapsible-content"]') !== null;
			expect(g.hasAttribute("data-open"), `group ${i} open`).toBe(pageOpen);
		}

		const pageRows = all(page, '[role="switch"]');
		const skeletonRows = all(skeleton, '[data-slot="roles-skeleton-permission"]');
		expect(pageRows.length).toBeGreaterThan(0);
		expect(skeletonRows).toHaveLength(pageRows.length);
		for (const r of skeletonRows) expect(r.className).toBe(PERMISSION_ROW_CLASS);
	});

	it("the first built-in grants everything, so the matrix it draws is the whole registry", () => {
		const skeleton = render(<RolesSkeleton />).container;
		expect(all(skeleton, '[data-slot="roles-skeleton-permission"]')).toHaveLength(PERMISSIONS.length);
	});
});
