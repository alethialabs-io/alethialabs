// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners page's two layout grids, named once so the page and its skeleton cannot drift apart
// (RUBRIC B2: a skeleton in a different grid is a layout shift when the data lands).

/** The page's two columns: pools + versions on the left, the runner grid on the right. */
export const RUNNERS_COLUMNS =
	"grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(320px,0.36fr)_minmax(0,0.64fr)]";

/** The runner card grid. */
export const RUNNERS_GRID = "grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]";
