// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Loads `href` as a new document. Unlike a router push, this ends the current page, so the next
 * one starts with new query clients, stores and modules. In its own module so that a component
 * test can replace it; jsdom does not implement navigation.
 */
export function hardNavigate(href: string): void {
	window.location.assign(href);
}
