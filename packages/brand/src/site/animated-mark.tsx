// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useRef } from "react";
import { AlethiaLockup } from "../lockup";

/**
 * Scroll thresholds, in px. Compact once the page has left the top, expanded again
 * only once it is back near it: the gap between the two is the hysteresis that
 * stops the mark flickering when a trackpad settles right on one number.
 */
const COMPACT_ABOVE = 24;
const EXPAND_BELOW = 8;

/**
 * The header's animated logo: `[ Alethia · LABS ]` at the top of the page, folding
 * into `[ · ]` once you scroll. The dot between the two words IS the mark's dot, so
 * the logo collapses into its own mark.
 *
 * All motion is CSS (`.ah-mark` in `tokens.css`). This component does two things
 * only: it writes each word's measured width into `--w` — the value its
 * `max-width` transitions from, re-measured once fonts load and on resize — and it
 * toggles `data-compact` from a passive scroll listener. Nothing runs per frame.
 *
 * The attribute is written straight onto the element rather than through React
 * state: it is not in the JSX, so React never reconciles it, and a scroll past the
 * threshold costs one attribute write instead of a re-render of the header.
 *
 * The drawing is `AlethiaLockup` itself (`../lockup.tsx`) — the same lockup the footer,
 * the console and the docs render — so the animated logo cannot drift from the static
 * one. Purely visual: the lockup is `aria-hidden`, so the enclosing link must carry
 * the accessible name.
 */
export function AnimatedMark() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const mark = ref.current;
    if (!mark) return;

    /** Writes each word's natural width into its `--w`, the max-width it folds from. */
    const measure = () => {
      for (const word of mark.querySelectorAll<HTMLElement>(".ah-mark__word")) {
        const inner = word.firstElementChild;
        if (!inner) continue;
        word.style.setProperty("--w", `${Math.ceil(inner.scrollWidth + 1)}px`);
      }
    };

    let compact = false;
    /** Toggles compact past the thresholds; the only work a scroll event does. */
    const onScroll = () => {
      const y = window.scrollY;
      if (!compact && y > COMPACT_ABOVE) {
        compact = true;
        mark.setAttribute("data-compact", "");
      } else if (compact && y < EXPAND_BELOW) {
        compact = false;
        mark.removeAttribute("data-compact");
      }
    };

    let frame = 0;
    /** Re-measures at most once per frame while a resize is in progress. */
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    let alive = true;
    measure();
    // The first measure can run on the fallback face, whose metrics differ from
    // Space Grotesk's and Geist Mono's, so measure again once the real faces are in.
    void document.fonts.ready.then(() => {
      if (alive) measure();
    });
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <AlethiaLockup ref={ref} tag="labs" animated />;
}
