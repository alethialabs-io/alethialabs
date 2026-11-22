// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page itself — hand-written HTML + CSS, no framework.
 *
 * WHY NOT REUSE @repo/ui
 *
 * This runs in a Worker with a 10 ms CPU budget per request and no React; it renders once per
 * changed snapshot on the cron and the request path only slices a string out of KV. So the TOKENS
 * are copied (they are the brand) and the markup is written by hand against them.
 * `packages/brand/src/tokens.css` remains the source of truth — if the two ever disagree, that file
 * wins.
 *
 * The one exception is the logo. The header lockup, its CSS and the favicon are NOT hand-written:
 * `scripts/gen-brand.ts` renders them from packages/brand into `brand.generated.ts`, and
 * tests/brand.test.ts fails if that module drifts — so this page draws exactly the main site's logo.
 *
 * THE RULE THAT LOOKS LIKE A BUG
 *
 * There is no hue on this page — not even red for an outage. The Alethia system is fully grayscale,
 * and status is carried by the dot's SHAPE plus a mono label, the same grammar as `.vx-status` in
 * tokens.css: a solid disc is operational, a hollow ring is degraded, a disc with a punched-out
 * centre is down. Each row also prints the word, so nothing depends on telling two greys apart.
 */

import { FAVICON_SVG, LOCKUP_CSS, LOCKUP_HTML } from "./brand.generated";
import type { Health } from "./probes";
import type { Summary } from "./state";

/** Served at /favicon.svg. Re-exported so `worker.ts` needs no second import. */
export { FAVICON_SVG };

/** Where the page lives. Every link it emits is root-relative to this host. */
export const BASE_PATH = "/";
export const SITE = "https://status.alethialabs.io";

const FONTS =
	"https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap";

/**
 * Tokens lifted from packages/brand/src/tokens.css. DARK in :root — dark is the signature surface —
 * and light under the media query.
 *
 * NO BACKTICKS ANYWHERE IN THIS STRING, comments included — it is a template literal, so one
 * backtick ends it and the rest of the file parses as TypeScript. That happened twice on TOVR's
 * copy; tests/render.test.ts renders the page so it fails loudly here.
 */
const CSS = `
:root{
  color-scheme:dark;
  --bg:oklch(0.130 0 0);--surface:oklch(0.165 0 0);
  --text-1:oklch(0.985 0 0);--text-2:oklch(0.664 0 0);--text-3:oklch(0.610 0 0);
  --faint:oklch(0.440 0 0);
  --border:oklch(1 0 0 / 0.10);--border-strong:oklch(1 0 0 / 0.17);
  --bar-up:oklch(0.556 0 0);
  --radius:4px;
  /* The lockup CSS (LOCKUP_CSS) reads --font-grotesk, --font-geist-sans and --font-mono, the names the
     Next apps get from next/font. All three must be set: one undefined var() voids the whole
     font-family declaration and the wordmark would fall back to the body face. */
  --font-geist-sans:Geist;
  --font-sans:Geist,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,sans-serif;
  --font-mono:Geist Mono,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,monospace;
  --font-grotesk:Space Grotesk,Geist,-apple-system,sans-serif;
}
@media (prefers-color-scheme:light){
  :root{
    color-scheme:light;
    --bg:oklch(0.985 0 0);--surface:oklch(1 0 0);
    --text-1:oklch(0.165 0 0);--text-2:oklch(0.440 0 0);--text-3:oklch(0.527 0 0);
    --faint:oklch(0.788 0 0);
    --border:oklch(0.928 0 0);--border-strong:oklch(0.882 0 0);
    --bar-up:oklch(0.664 0 0);
  }
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text-1);font-family:var(--font-sans);
  font-size:15px;line-height:1.5;letter-spacing:-0.01em;-webkit-font-smoothing:antialiased}
a{color:inherit;text-underline-offset:3px}
a:focus-visible,b:focus-visible{outline:1px solid var(--text-1);outline-offset:2px}
.wrap{max-width:960px;margin:0 auto;padding:0 24px}
@media (max-width:640px){.wrap{padding:0 16px}}

header{border-bottom:1px solid var(--border)}
/* Longhands, not the padding shorthand: this element also carries .wrap, whose own shorthand would
   be overridden wholesale and take the horizontal gutter with it. */
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:18px;padding-bottom:18px}
/* The lockup's own rules come from packages/brand (LOCKUP_CSS, appended below); this only places it,
   as the main site's header link does: no underline, the ink colour inherited. */
.brand{display:flex;color:var(--text-1);text-decoration:none}
.eyebrow{font-family:var(--font-mono);font-weight:500;font-size:11px;letter-spacing:0.16em;
  text-transform:uppercase;color:var(--text-3)}

.banner{display:flex;align-items:center;gap:14px;padding:40px 0 28px}
.banner h1{margin:0;font-family:var(--font-grotesk);font-size:26px;font-weight:600;letter-spacing:-0.03em}
.banner p{margin:4px 0 0;color:var(--text-2);font-size:13.5px}

/* The status dot: SHAPE carries the state, never hue (tokens.css .vx-status). */
.dot{display:inline-block;width:8px;height:8px;border-radius:9999px;flex:0 0 auto;position:relative}
.dot.up{background:var(--text-1)}
.dot.degraded{background:transparent;border:1.5px solid var(--text-1)}
.dot.down{background:var(--text-1)}
.dot.down::after{content:"";position:absolute;inset:2px;background:var(--bg);border-radius:1px}
.dot.lg{width:12px;height:12px}
.dot.lg.down::after{inset:3px}

.label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.06em;text-transform:uppercase}
.label.up{color:var(--text-2)}
.label.degraded,.label.down{color:var(--text-1);font-weight:500}

/* Not overflow:hidden: that clipped the day popovers, which sit above their bar. */
.panel{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
.row{display:grid;grid-template-columns:1fr auto;gap:8px 24px;padding:16px 18px;border-top:1px solid var(--border)}
.row:first-child{border-top:0}
.row .name{font-weight:500;font-size:14px}
.row .desc{color:var(--text-2);font-size:13px;margin-top:2px}
.row .state{display:flex;align-items:center;gap:8px;white-space:nowrap}
.row .reason{grid-column:1/-1;font-family:var(--font-mono);font-size:12px;color:var(--text-1);word-break:break-word}
.row .reason::before{content:"\\2192  ";color:var(--text-3)}

/* A day with no data must NOT look like a day that was up. Padding the bar to 90 slots is honest
   only if the padding reads as absence, so absence is a faint hairline against a full-height mark. */
.bar{grid-column:1/-1;display:flex;gap:2px;align-items:center;height:22px;margin-top:12px}
/* Each slot is its own positioning context, so the popover needs no JavaScript. A bare b is not
   focusable, hence tabindex and role on every slot. */
.bar b{flex:1 1 0;min-width:1px;position:relative;display:flex;align-items:center;height:100%;cursor:default}
.bar b>i{width:100%;border-radius:1px;display:block}
.bar b>i.none{height:4px;background:var(--border)}
.bar b>i.up{height:100%;background:var(--bar-up)}
/* A partial day is an OUTLINE, a major day is solid full ink: shape and weight, not colour. */
.bar b>i.degraded{height:100%;background:transparent;box-shadow:inset 0 0 0 1px var(--text-1)}
.bar b>i.down{height:100%;background:var(--text-1)}
.day{position:absolute;bottom:calc(100% + 8px);left:50%;translate:-50% 0;min-width:184px;max-width:264px;
  padding:8px 10px;z-index:10;background:var(--surface);border:1px solid var(--border-strong);
  border-radius:var(--radius);text-align:left;white-space:normal;opacity:0;visibility:hidden;transition:opacity .12s ease}
/* focus-visible, not focus: a plain focus left a clicked day's popover stuck open. */
.bar b:hover .day,.bar b:focus-visible .day{opacity:1;visibility:visible}
.bar b:nth-child(-n+6) .day{left:0;translate:0 0}
.bar b:nth-child(n+85) .day{left:auto;right:0;translate:0 0}
.day .d{font-family:var(--font-mono);font-size:11px;color:var(--text-3);display:block;margin-bottom:3px}
.day .s{font-size:12.5px;display:block}
@media (hover:none){.day{display:none}}
.legend{grid-column:1/-1;display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-3);margin-top:6px}
.legend .pct{font-family:var(--font-mono)}

section{padding:36px 0 0}
section h2{margin:0 0 12px}
.incident{padding:15px 18px;border-top:1px solid var(--border)}
.incident:first-child{border-top:0}
.incident .top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.incident .who{font-weight:500;font-size:14px}
/* The status word is a hairline chip: an incident LIST is history, and history that shouts reads as
   an outage happening now. An open one gets the strong border and full ink. */
.tag{font-family:var(--font-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:0.06em;
  color:var(--text-3);border:1px solid var(--border-strong);padding:1px 6px}
.tag.open{color:var(--text-1);border-color:var(--text-1)}
.incident .dur{font-family:var(--font-mono);font-size:11.5px}
.incident .when{font-family:var(--font-mono);font-size:11.5px;color:var(--text-3);margin-top:5px}
.incident .when time{white-space:nowrap}
.incident .why{font-family:var(--font-mono);font-size:12px;color:var(--text-2);margin-top:5px;word-break:break-word}
.empty{padding:16px 18px;color:var(--text-2);font-size:13.5px}

footer{margin-top:48px;border-top:1px solid var(--border)}
.foot{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:20px;padding-bottom:40px;
  color:var(--text-3);font-size:12.5px}
footer .ts{font-family:var(--font-mono)}
`;

/** Browser chrome in the page's own grey. There is no state colour to agree with. */
const THEME_COLOR = "#141414";

/** The mono word next to each dot. */
const HEALTH_LABEL: Record<Health, string> = {
	up: "Operational",
	degraded: "Degraded",
	down: "Down",
};

/** The banner headline per overall state. */
const BANNER: Record<Summary["state"], { title: string; dot: Health }> = {
	operational: { title: "All systems operational", dot: "up" },
	degraded: { title: "Some systems degraded", dot: "degraded" },
	outage: { title: "Major outage", dot: "down" },
};

const CHECKED_EVERY = "Checked every minute from outside our infrastructure.";

// Built ONCE per module rather than once per slot — there are 630 day slots, and constructing a
// DateTimeFormat is the expensive part of using one. UTC on both: the stamps ARE UTC and the page
// prints the zone next to every time, because this HTML is rendered once on a cron and served to
// everyone, so there is no reader zone to honour.
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
// Two decimals: three nines and four nines must not render identically.
const PERCENT = new Intl.NumberFormat("en-GB", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Escape a value for HTML text or a double-quoted attribute. Every interpolated value goes through this. */
function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A fraction as a two-decimal percentage, or an em dash when there is no data. */
function pct(fraction: number | null): string {
	return fraction === null ? "—" : PERCENT.format(fraction);
}

/** "1 day" / "3 days" — English plural for a count. */
function days(n: number): string {
	return n === 1 ? "1 day" : `${n} days`;
}

/** One sentence that changes with the state — a static description would be a lie half the time. */
function describe(s: Summary): string {
	const notUp = s.components.filter((c) => c.health !== "up").length;
	const total = s.components.length;
	const head =
		notUp === 0
			? `All ${total} Alethia systems are operational.`
			: `${notUp} of ${total} Alethia systems ${notUp === 1 ? "is" : "are"} not fully operational.`;
	return `${head} ${CHECKED_EVERY}`;
}

/**
 * The uptime bar renders a FIXED 90 slots, oldest first, padding the left with "no data" rather than
 * stretching what history exists across the full width. Stretching would make a two-day-old page
 * look like ninety days of perfect uptime — the most flattering lie a status page can tell.
 */
const BAR_DAYS = 90;

/** "2026-06-15" → "15 Jun 2026", or the input if it is not a day. */
function longDay(iso: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
	const ms = Date.parse(`${iso}T00:00:00Z`);
	return Number.isFinite(ms) ? DAY.format(ms) : iso;
}

/**
 * What a day's popover says, in that COMPONENT's terms. One check a minute, so a failed check IS a
 * failed minute; past a tenth of the day it is a major outage.
 */
function dayCopy(d: { total: number; up: number }): string {
	if (d.total === 0) return "No data recorded.";
	const failed = d.total - d.up;
	if (failed === 0) return "No downtime recorded.";
	const dur =
		failed < 60 ? `${failed} min` : `${Math.floor(failed / 60)}h ${String(failed % 60).padStart(2, "0")}m`;
	const uptime = pct(d.up / d.total);
	return failed / d.total > 0.1
		? `Major outage — ${dur} down (${uptime} uptime).`
		: `Partial outage — ${dur} down (${uptime} uptime).`;
}

/** The 90-slot uptime bar for one component. */
function bar(history: Summary["components"][number]["history"]): string {
	const recent = history.slice(-BAR_DAYS);
	const pad = BAR_DAYS - recent.length;
	const slots: string[] = [];
	const empty =
		'<b tabindex="0" role="img" aria-label="No data"><i class="none"></i>' +
		'<span class="day"><span class="s">No data.</span></span></b>';
	for (let i = 0; i < pad; i++) slots.push(empty);
	for (const d of recent) {
		const failed = d.total - d.up;
		const cls = d.total === 0 ? "none" : failed === 0 ? "up" : failed / d.total > 0.1 ? "down" : "degraded";
		const text = dayCopy(d);
		const day = longDay(d.day);
		slots.push(
			`<b tabindex="0" role="img" aria-label="${esc(`${day}: ${text}`)}"><i class="${cls}"></i>` +
				`<span class="day"><span class="d">${esc(day)}</span><span class="s">${esc(text)}</span></span></b>`,
		);
	}
	return `<div class="bar">${slots.join("")}</div>`;
}

/**
 * "90 days ago" is a lie on a component watched for nine of them, sitting next to a "100.00%" figure.
 * Say how much data there actually is until there are ninety days of it.
 */
function windowLabel(daysOfData: number): string {
	if (daysOfData >= BAR_DAYS) return `${days(BAR_DAYS)} ago`;
	if (daysOfData === 0) return "no data yet";
	return `${days(daysOfData)} of data`;
}

/** One component row: name, state, reason (when not up), bar and legend. */
function componentRow(c: Summary["components"][number]): string {
	const reason = c.reason && c.health !== "up" ? `<div class="reason">${esc(c.reason)}</div>` : "";
	return `<div class="row">
  <div>
    <div class="name">${esc(c.name)}</div>
    <div class="desc">${esc(c.description)}</div>
  </div>
  <div class="state"><span class="dot ${c.health}"></span><span class="label ${c.health}">${HEALTH_LABEL[c.health]}</span></div>
  ${reason}
  ${bar(c.history)}
  <div class="legend"><span>${esc(windowLabel(c.history.length))}</span><span class="pct">${esc(`${pct(c.uptime90d)} uptime`)}</span><span>today</span></div>
</div>`;
}

/** An ISO stamp as { day, time } in UTC, or null when it is not one. Seconds are dropped on purpose. */
function stamp(iso: string): { day: string; time: string } | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return null;
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return null;
	return { day: DAY.format(ms), time: TIME.format(ms) };
}

/** How long it lasted, in the two largest units that carry information — "16h 27m", "1d 4h", "4m". */
function lasted(startIso: string, endIso: string): string | null {
	const a = Date.parse(startIso);
	const b = Date.parse(endIso);
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
	const secs = Math.round((b - a) / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A machine-readable stamp with a human face over it. */
function timeTag(iso: string, text: string): string {
	return `<time datetime="${esc(iso)}">${esc(text)}</time>`;
}

/** The window an incident covers, saying the date ONCE when both ends fall on the same day. */
function incidentWindow(startIso: string, endIso: string | null, now: string): string {
	const a = stamp(startIso);
	if (!a) return esc(startIso);
	const from = timeTag(startIso, `${a.day}, ${a.time}`);
	if (endIso === null) {
		const span = lasted(startIso, now);
		return `${from} UTC → ${span ? `ongoing (${esc(span)} so far)` : "ongoing"}`;
	}
	const b = stamp(endIso);
	if (!b) return `${from} UTC`;
	// Both ends inside one minute: "09:30 → 09:30" reads as a zero-length window. One stamp; .dur says how long.
	if (b.day === a.day && b.time === a.time) return `${from} UTC`;
	const to = timeTag(endIso, b.day === a.day ? b.time : `${b.day}, ${b.time}`);
	return `${from}${b.day === a.day ? "" : " UTC"} → ${to} UTC`;
}

/**
 * One incident, reported rather than dumped. `now` is the snapshot's own generatedAt, not the clock,
 * so an ongoing incident's duration is a property of the snapshot and the render is deterministic.
 */
function incidentItem(i: Summary["incidents"][number], now: string): string {
	const span = i.resolvedAt === null ? null : lasted(i.startedAt, i.resolvedAt);
	const resolved = i.resolvedAt !== null;
	return `<div class="incident">
  <div class="top">
    <span class="dot ${resolved ? "up" : i.worst}"></span>
    <span class="who">${esc(i.componentName)}</span>
    <span class="tag${resolved ? "" : " open"}">${resolved ? "Resolved" : "Ongoing"}</span>
    ${span ? `<span class="dur">lasted ${esc(span)}</span>` : ""}
  </div>
  <div class="when">${incidentWindow(i.startedAt, i.resolvedAt, now)}</div>
  ${i.reason ? `<div class="why">${esc(i.reason)}</div>` : ""}
</div>`;
}

/** "Updated 22 Aug 2026, 12:00 UTC", with the exact stamp kept machine-readable. */
function updatedLine(iso: string): string {
	const st = stamp(iso);
	return `Updated ${timeTag(iso, st ? `${st.day}, ${st.time} UTC` : iso)}`;
}

/** A section heading in the system's eyebrow voice. */
function heading(text: string): string {
	return `<h2 class="eyebrow">${esc(text)}</h2>`;
}

/**
 * Schema.org `WebSite`, so a search result can say what this page is. There is no schema.org type
 * for "status page", and inventing one produces a rich-result warning rather than a richer result.
 */
function structuredData(s: Summary): unknown {
	return {
		"@context": "https://schema.org",
		"@type": "WebSite",
		name: "Alethia Status",
		url: SITE,
		inLanguage: "en",
		description: describe(s),
		publisher: { "@type": "Organization", name: "Alethia Labs", url: "https://alethialabs.io" },
	};
}

/** Render the whole page from one summary — what the cron writes to KV. */
export function renderPage(s: Summary): string {
	const b = BANNER[s.state];
	const title = `Alethia Status — ${b.title}`;
	const description = describe(s);
	const open = s.incidents.filter((i) => i.resolvedAt === null);
	const past = s.incidents.filter((i) => i.resolvedAt !== null).slice(0, 20);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="${THEME_COLOR}">
<meta name="robots" content="index,follow">
<link rel="icon" type="image/svg+xml" href="${BASE_PATH}favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Alethia Labs">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/json" href="${BASE_PATH}api/summary.json" title="Alethia status API">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${CSS}${LOCKUP_CSS}</style>
<script type="application/ld+json">${esc(JSON.stringify(structuredData(s)))}</script>
</head>
<body>
<header><div class="wrap head">
  <a class="brand" href="https://alethialabs.io" aria-label="Alethia Labs home">${LOCKUP_HTML}</a>
  <span class="eyebrow">Status</span>
</div></header>

<main class="wrap">
  <div class="banner">
    <span class="dot lg ${b.dot}"></span>
    <div><h1>${esc(b.title)}</h1><p>${esc(CHECKED_EVERY)}</p></div>
  </div>

  <div class="panel">${s.components.map(componentRow).join("")}</div>

  <section>
    ${heading("Active incidents")}
    <div class="panel">${
			open.length
				? open.map((i) => incidentItem(i, s.generatedAt)).join("")
				: '<div class="empty">No active incidents.</div>'
		}</div>
  </section>

  <section>
    ${heading("Recent history")}
    <div class="panel">${
			past.length
				? past.map((i) => incidentItem(i, s.generatedAt)).join("")
				: '<div class="empty">Nothing to report.</div>'
		}</div>
  </section>
</main>

<footer><div class="wrap foot">
  <span class="ts">${updatedLine(s.generatedAt)}</span>
  <span><a href="${BASE_PATH}api/summary.json">JSON API</a> · <a href="https://alethialabs.io">alethialabs.io</a></span>
</div></footer>
</body>
</html>`;
}
