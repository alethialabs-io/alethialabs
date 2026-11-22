// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The interim [·] mark — a focal point inside brackets — as the Worker serves it. The geometry is
// copied from .claude/skills/alethia-design/assets/favicon.svg (the app icon) and its inline form;
// served by the Worker itself because this page is read during an incident, and a favicon that 404s
// because a second origin is down is a small, avoidable lie about the page's own health.

/** The app icon: the mark on an ink tile. Served at /favicon.svg. */
export const FAVICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Alethia Labs">' +
	'<rect width="32" height="32" rx="7" fill="#1A1A1A"/>' +
	'<g transform="translate(3.5 3.5) scale(0.78)" fill="none">' +
	'<path d="M11 6 H6.5 V26 H11" stroke="#FAFAFA" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
	'<path d="M21 6 H25.5 V26 H21" stroke="#FAFAFA" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
	'<circle cx="16" cy="16" r="3.1" fill="#FAFAFA"/>' +
	"</g></svg>";

/** The bare mark in `currentColor`, for the header lockup. Decorative: the wordmark beside it is the name. */
export const MARK_SVG =
	'<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none">' +
	'<path d="M11 6 H6.5 V26 H11" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
	'<path d="M21 6 H25.5 V26 H21" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
	'<circle cx="16" cy="16" r="3.1" fill="currentColor"/>' +
	"</svg>";
