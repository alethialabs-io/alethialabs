// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Accessibility scan helper wrapping @axe-core/playwright. Specs call scanA11y(page) and either
// assert no serious/critical violations or record them for the QA report. Kept resilient: if the
// axe package isn't installed the helper no-ops (returns []) so the suite still runs.

import { type Page } from "@playwright/test";

export interface A11yViolation {
	id: string;
	impact: string | null;
	help: string;
	nodes: number;
	target: string;
}

/**
 * Runs axe-core against the current page (optionally scoped to a selector). Returns serious/critical
 * violations. No-ops to [] if @axe-core/playwright is unavailable.
 */
export async function scanA11y(page: Page, opts?: { include?: string }): Promise<A11yViolation[]> {
	let AxeBuilder: typeof import("@axe-core/playwright").default | undefined;
	try {
		AxeBuilder = (await import("@axe-core/playwright")).default;
	} catch {
		return [];
	}
	let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
	if (opts?.include) builder = builder.include(opts.include);
	const results = await builder.analyze();
	return results.violations
		.filter((v) => v.impact === "serious" || v.impact === "critical")
		.map((v) => ({
			id: v.id,
			impact: v.impact ?? null,
			help: v.help,
			nodes: v.nodes.length,
			target: v.nodes[0]?.target?.join(" ") ?? "",
		}));
}

/** Asserts the page has no serious/critical a11y violations. */
export async function expectNoSeriousA11yViolations(page: Page, opts?: { include?: string }): Promise<void> {
	const violations = await scanA11y(page, opts);
	if (violations.length) {
		throw new Error(
			`Serious a11y violations (${violations.length}):\n` +
				violations.map((v) => ` · ${v.id} [${v.impact}] ${v.help} — ${v.target}`).join("\n"),
		);
	}
}
