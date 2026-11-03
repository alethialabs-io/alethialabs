// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the roles route's `loading.tsx` renders this, and it is a server component.

import type { ReactNode } from "react";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import {
	builtInRoleLabels,
	DETAIL_BODY_CLASS,
	DETAIL_CLASS,
	DETAIL_DESCRIPTION_CLASS,
	DETAIL_FOOTER_CLASS,
	DETAIL_HEADER_CLASS,
	DETAIL_ICON_SIZE,
	DETAIL_KIND_PILL_CLASS,
	DETAIL_NAME_CLASS,
	DETAIL_TITLE_ROW_CLASS,
	firstBuiltInRole,
	GROUP_CHEVRON_SIZE,
	GROUP_CLASS,
	GROUP_COUNT_CLASS,
	GROUP_LABEL_CLASS,
	GROUP_LABEL_ROW_CLASS,
	GROUP_ROWS_CLASS,
	GROUP_TRIGGER_CLASS,
	grantedInGroup,
	MATRIX_CLASS,
	PERMISSION_ACTION_CLASS,
	PERMISSION_GROUPS,
	PERMISSION_KEY_CLASS,
	PERMISSION_ROW_CLASS,
	PERMISSIONS_COUNT_CLASS,
	PERMISSIONS_LABEL_CLASS,
	permissionActionLabel,
	RAIL_CLASS,
	RAIL_DIVIDER_CLASS,
	RAIL_HEADING_CLASS,
	RAIL_ROW_CLASS,
	RAIL_ROW_COUNT_CLASS,
	RAIL_ROW_NAME_CLASS,
	ROLES_GRID_CLASS,
} from "./roles-parts";

/**
 * Text the page will show, drawn as a placeholder: the real copy in the element's own type, made
 * transparent over a pulsing bar. It is exactly as tall as the line that replaces it, and wraps
 * where that line wraps, because it IS that line — only its ink is missing.
 */
function Blank({ children }: { children: ReactNode }) {
	return <span className="animate-pulse rounded-sm bg-accent text-transparent">{children}</span>;
}

/** A placeholder the size of an icon, where the page draws one. */
function IconSlot({ size }: { size: number }) {
	return <span aria-hidden className="shrink-0" style={{ width: size, height: size }} />;
}

/**
 * The search box's placeholder. `FilterSearch` is a 36px (`h-9`) field, and the bar that stood in
 * for it was 32px, which put the whole master/detail 4px low (#6353). Same height, same width
 * classes.
 */
function SearchSlot() {
	return <Skeleton className="h-8 w-[240px] max-w-[380px] flex-1 rounded-sm" />;
}

/**
 * The loading form of the Roles page (`RolesManager`), drawn from the page's own parts
 * (`roles-parts.ts`) so it cannot drift from it (#6129, #6353 — RUBRIC B2): the toolbar (count,
 * one line, Create role), the filter bar (search, Kind), then the master/detail — the 260px rail
 * with its two buckets, and the detail panel showing the role the page opens on.
 *
 * That role is the first built-in, a registry template, so the panel draws its real header and its
 * real matrix: the same groups, open where the page opens them, with the same rows. The page's
 * panel for it runs far below the fold, and a box of six bars in its place was a 339px skeleton
 * becoming a 701px panel.
 */
export function RolesSkeleton() {
	const role = firstBuiltInRole();
	const granted = new Set(role.permissionKeys);
	return (
		<div aria-busy data-slot="roles-skeleton">
			<PageToolbarSkeleton className="mb-4" count actions={1} />
			<div aria-hidden data-slot="roles-skeleton-filter-bar" className="mb-4 flex flex-wrap items-center gap-2.5">
				<SearchSlot />
				<Skeleton className="h-8 w-28 rounded-md" />
			</div>
			<div aria-hidden data-slot="roles-skeleton-grid" className={ROLES_GRID_CLASS}>
				<div data-slot="roles-skeleton-rail" className={RAIL_CLASS}>
					<div className={RAIL_HEADING_CLASS}>
						<Blank>Built-in</Blank>
					</div>
					{builtInRoleLabels().slice(1).map((label) => (
						<div key={label} data-slot="roles-skeleton-rail-row" className={RAIL_ROW_CLASS}>
							<span className={RAIL_ROW_NAME_CLASS}>
								<Blank>{label}</Blank>
							</span>
							<span className={RAIL_ROW_COUNT_CLASS}>
								<Blank>00</Blank>
							</span>
						</div>
					))}
					<div className={RAIL_DIVIDER_CLASS} />
					<div className={RAIL_HEADING_CLASS}>
						<Blank>Custom</Blank>
					</div>
				</div>
				<div data-slot="roles-skeleton-detail" className={DETAIL_CLASS}>
					<div data-slot="roles-skeleton-detail-header" className={DETAIL_HEADER_CLASS}>
						<div className="min-w-0">
							<div className={DETAIL_TITLE_ROW_CLASS}>
								<IconSlot size={DETAIL_ICON_SIZE} />
								<span className={DETAIL_NAME_CLASS}>
									<Blank>{role.label}</Blank>
								</span>
								<span className={cn(DETAIL_KIND_PILL_CLASS, "border-transparent")}>
									<Blank>Built-in</Blank>
								</span>
							</div>
							<p className={DETAIL_DESCRIPTION_CLASS}>
								<Blank>{role.description}</Blank>
							</p>
						</div>
					</div>
					<div className={DETAIL_BODY_CLASS}>
						<p className={PERMISSIONS_LABEL_CLASS}>
							<Blank>Permissions</Blank>{" "}
							<span className={PERMISSIONS_COUNT_CLASS}>
								<Blank>({role.permissionKeys.length})</Blank>
							</span>
						</p>
						<div className={MATRIX_CLASS}>
							{PERMISSION_GROUPS.map((g) => {
								const open = grantedInGroup(g, granted) > 1000;
								return (
									<div
										key={g.resource}
										data-slot="roles-skeleton-group"
										data-open={open ? "" : undefined}
										className={GROUP_CLASS}
									>
										<div className={GROUP_TRIGGER_CLASS}>
											<span className={GROUP_LABEL_ROW_CLASS}>
												<span className={GROUP_LABEL_CLASS}>
													<Blank>{g.label}</Blank>
												</span>
												<span className={cn(GROUP_COUNT_CLASS, "border-transparent")}>
													<Blank>
														{grantedInGroup(g, granted)}/{g.permissions.length}
													</Blank>
												</span>
											</span>
											<IconSlot size={GROUP_CHEVRON_SIZE} />
										</div>
										{open ? (
											<div className={GROUP_ROWS_CLASS}>
												{g.permissions.map((p) => (
													<div
														key={p.key}
														data-slot="roles-skeleton-permission"
														className={PERMISSION_ROW_CLASS}
													>
														<div className="min-w-0">
															<p className={PERMISSION_ACTION_CLASS}>
																<Blank>{permissionActionLabel(p.action)}</Blank>
															</p>
															<p className={PERMISSION_KEY_CLASS}>
																<Blank>{p.key}</Blank>
															</p>
														</div>
														{/* The switch's own box: `@repo/ui/switch` is 1.15rem by 2rem. */}
														<Skeleton className="h-[1.15rem] w-8 shrink-0 rounded-full" />
													</div>
												))}
											</div>
										) : null}
									</div>
								);
							})}
						</div>
					</div>
					<div className={DETAIL_FOOTER_CLASS}>
						<Skeleton className="h-5 w-48" />
					</div>
				</div>
			</div>
		</div>
	);
}
