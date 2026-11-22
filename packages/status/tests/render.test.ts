// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { COMPONENTS, rollUp, type Health } from "../src/probes";
import { renderPage } from "../src/render";
import { uptimeFraction, type ComponentSummary, type DayRollup, type IncidentSummary, type Summary } from "../src/state";

/**
 * The CSS is a template literal, so a single backtick anywhere in it ends the string and the rest of
 * the file parses as TypeScript. Merely IMPORTING ../src/render is most of this file's value; the
 * assertions cover the rendering decisions that are easy to get wrong and impossible to notice.
 */

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-21T12:00:00.000Z");

/** `n` days of history ending today, with `downOn[i]` failed minutes `i` days ago. */
function history(n: number, downOn: Record<number, number> = {}): DayRollup[] {
	const out: DayRollup[] = [];
	for (let i = n - 1; i >= 0; i--) {
		out.push({ day: new Date(NOW - i * DAY_MS).toISOString().slice(0, 10), total: 1440, up: 1440 - (downOn[i] ?? 0) });
	}
	return out;
}

/** A summary with every component up and `historyDays` of history. */
function summary(over: Partial<Summary> = {}, historyDays = 90): Summary {
	const components: ComponentSummary[] = COMPONENTS.map((c) => {
		const h = history(historyDays);
		const health: Health = "up";
		return { id: c.id, name: c.name, description: c.description, health, reason: null, ms: 100, uptime90d: uptimeFraction(h), history: h };
	});
	return {
		version: 1,
		generatedAt: new Date(NOW).toISOString(),
		state: rollUp(components),
		components,
		incidents: [],
		...over,
	};
}

/** The first component, which every summary() has. */
function first(s: Summary): ComponentSummary {
	const c = s.components[0];
	if (!c) throw new Error("no components");
	return c;
}

/** An incident on the database. */
function incident(over: Partial<IncidentSummary> = {}): IncidentSummary {
	return {
		id: 1,
		component: "database",
		componentName: "Database",
		startedAt: "2026-11-20T15:45:05.000Z",
		resolvedAt: "2026-11-21T08:12:17.000Z",
		worst: "down",
		reason: "schema: missing",
		...over,
	};
}

describe("renderPage", () => {
	it("renders a complete English document with every component on it", () => {
		const html = renderPage(summary());
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html.trimEnd().endsWith("</html>")).toBe(true);
		expect(html).toContain('<html lang="en">');
		for (const c of COMPONENTS) expect(html).toContain(c.name);
	});

	it("titles the tab with the actual state", () => {
		expect(renderPage(summary())).toContain("<title>Alethia Status — All systems operational");
		const s = summary();
		first(s).health = "down";
		s.state = "outage";
		expect(renderPage(s)).toContain("<title>Alethia Status — Major outage");
	});

	it("carries the brand: the [·] mark, the lockup, and the three typefaces", () => {
		const html = renderPage(summary());
		expect(html).toContain('<svg class="mark"');
		expect(html).toContain('<span class="word">Alethia</span><span class="labs">Labs</span>');
		for (const face of ["family=Geist:", "family=Geist+Mono", "family=Space+Grotesk"]) expect(html).toContain(face);
	});

	/**
	 * The brand is fully grayscale and status never rides on hue. Every colour the CSS declares must be
	 * a zero-chroma OKLCH (or a grey hex) — an outage drawn in red would be off-brand and, worse, the
	 * only cue a colour-blind reader could miss.
	 */
	it("declares no chromatic colour anywhere", () => {
		const html = renderPage(summary());
		const oklch = [...html.matchAll(/oklch\(([^)]*)\)/g)].map((m) => m[1] ?? "");
		expect(oklch.length).toBeGreaterThan(0);
		for (const args of oklch) expect(args.trim().split(/\s+/)[1]).toBe("0");
		for (const hex of html.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
			const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
			expect(r === g && g === b, hex).toBe(true);
		}
		expect(html).not.toMatch(/\b(?:rgb|hsl)a?\(/);
	});

	it("states each component's health as a WORD beside its dot shape", () => {
		const s = summary();
		first(s).health = "degraded";
		first(s).reason = "a background loop is behind";
		const html = renderPage(s);
		expect(html).toContain('<span class="dot degraded"></span><span class="label degraded">Degraded</span>');
		expect(html).toContain('<span class="label up">Operational</span>');
	});

	it("pads a short history with explicit no-data slots rather than stretching it", () => {
		const html = renderPage(summary({}, 9));
		expect((html.match(/class="none"/g) ?? []).length).toBe((90 - 9) * COMPONENTS.length);
		expect(renderPage(summary({}, 90))).not.toContain('class="none"');
	});

	it("shows a reason only when the component is not up", () => {
		const s = summary();
		first(s).reason = "stale reason from a healthy check";
		expect(renderPage(s)).not.toContain("stale reason from a healthy check");
		first(s).health = "down";
		first(s).reason = "openfga: unreachable";
		expect(renderPage(s)).toContain("openfga: unreachable");
	});

	it("escapes a reason so a probe error cannot inject markup", () => {
		const s = summary();
		first(s).health = "down";
		first(s).reason = '<img src=x onerror="alert(1)">';
		const html = renderPage(s);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
	});

	it("says so plainly when there is nothing to report", () => {
		const html = renderPage(summary());
		expect(html).toContain("No active incidents.");
		expect(html).toContain("Nothing to report.");
	});

	it("renders an ongoing incident differently from a resolved one", () => {
		const html = renderPage(
			summary({ incidents: [incident({ id: 2, resolvedAt: null, startedAt: "2026-11-21T09:30:00.000Z" }), incident()] }),
		);
		expect(html).toContain('class="tag">Resolved</span>');
		expect(html).toContain('class="tag open">Ongoing</span>');
		expect(html).toContain("ongoing (2h 30m so far)");
		expect(html).not.toContain("No active incidents.");
	});

	it("reports how long a resolved incident lasted, across midnight, without seconds", () => {
		const html = renderPage(summary({ incidents: [incident()] }));
		expect(html).toContain("lasted 16h 27m");
		expect(html).toContain('<time datetime="2026-11-20T15:45:05.000Z">20 Nov 2026, 15:45</time>');
		expect(html).toContain('<time datetime="2026-11-21T08:12:17.000Z">21 Nov 2026, 08:12</time> UTC');
	});

	it("renders an em dash for unknown uptime instead of a misleading 100%", () => {
		const s = summary();
		first(s).uptime90d = null;
		first(s).history = [];
		const html = renderPage(s);
		expect(html).toContain("— uptime");
		expect(html).toContain("no data yet");
	});

	it("reports a partial and a major day in the popover, as durations", () => {
		const s = summary();
		first(s).history = history(90, { 0: 34, 1: 200 });
		const html = renderPage(s);
		expect(html).toContain("Partial outage — 34 min down (97.64% uptime).");
		expect(html).toContain("Major outage — 3h 20m down");
	});

	it("describes the ACTUAL state in the meta description", () => {
		expect(renderPage(summary())).toContain("All 7 Alethia systems are operational.");
		const s = summary();
		first(s).health = "down";
		expect(renderPage(s)).toContain("1 of 7 Alethia systems is not fully operational.");
	});

	it("emits valid JSON-LD", () => {
		const m = renderPage(summary()).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
		const decoded = (m?.[1] ?? "")
			.replace(/&quot;/g, '"')
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
		expect(JSON.parse(decoded)).toMatchObject({ "@type": "WebSite", name: "Alethia Status" });
	});
});
