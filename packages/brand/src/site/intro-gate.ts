// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The once-per-session gate for the marketing intro splash (polish-wave spec §1, #7742).
 *
 * This is a plain module, NOT part of `intro-splash.tsx`, on purpose: that file is a
 * `"use client"` module, and a server component that imports a string from one receives a
 * client-reference proxy, not the string. The root layout needs the real text to inline it.
 */

/** The `sessionStorage` key the gate sets on a visitor's first load in a browser session. */
export const INTRO_SEEN_KEY = "alethia-intro-seen";

/**
 * The inline `<head>` script. It runs before first paint, so by the time the splash's HTML is
 * parsed `<html>` already says whether to show it:
 *
 * - key present: a repeat load in this session, so `data-intro="skip"` goes on `<html>` and the
 *   `[data-intro="skip"] .ah-intro { display: none }` rule in `tokens.css` hides the overlay
 *   before it can paint. It never flashes.
 * - key absent: the first load, so the key is set and nothing else changes. The splash plays.
 * - storage blocked (Safari private mode with storage disabled, a sandboxed frame, cookies
 *   blocked): even reading `sessionStorage` throws, so the script lands in `catch` and skips the
 *   splash. Showing nothing is the safe answer; without storage the gate could not stop the
 *   splash from replaying on every page.
 *
 * ES5 and self-contained, because it is inlined as text and runs before any bundle.
 */
export const INTRO_GATE_SCRIPT = `(function(){var d=document.documentElement;try{if(sessionStorage.getItem("${INTRO_SEEN_KEY}")){d.setAttribute("data-intro","skip")}else{sessionStorage.setItem("${INTRO_SEEN_KEY}","1")}}catch(e){d.setAttribute("data-intro","skip")}})();`;
