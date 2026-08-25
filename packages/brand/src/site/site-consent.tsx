// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The consent provider the chrome in this package REQUIRES, re-exported beside it.
 *
 * `SiteFooter` renders `PrivacySettingsButton`, which calls `useConsent()`, which THROWS when no
 * provider is above it. That contract used to be invisible: `apps/marketing` happened to satisfy it
 * and `apps/blog` drew its own footer, so nothing depended on the pairing. Promoting the chrome here
 * moved the footer into an app that had no provider, and the blog's `/` stopped prerendering — the
 * whole image build failed on it (#2593).
 *
 * Re-exported from `@repo/brand` rather than imported from `@repo/privacy` at each call site so an
 * app that takes this package's chrome can satisfy the requirement WITHOUT taking a second direct
 * dependency it would otherwise have no reason to declare. The chrome and its contract ship together.
 *
 * Deliberately NOT folded into `SiteShell`: `apps/marketing` already provides its own at the layout
 * root, and nesting two providers over one cookie is a second banner waiting to happen.
 */
export { ConsentProvider, useConsent } from "@repo/privacy/consent-provider";
