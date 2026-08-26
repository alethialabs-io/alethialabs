// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

interface ChromeProps {
	/**
	 * Render the two vertical rails at the left edge. Default `true` — every long
	 * scrolling page wants them.
	 *
	 * Turn them OFF on a short page whose own content reaches the bottom-left corner.
	 * `.vx-rail--bottom` is fixed at `bottom: 28px, left: 17px`, which is precisely
	 * where a compact footer's first line sits: on the console's auth screens the
	 * rail landed against "© 2026 Alethia Labs" and read as a collision, because it
	 * was one. The rails are a device for a page you scroll, not for a single card
	 * over a one-line footer.
	 */
	rails?: boolean;
}

/**
 * Page chrome: the hairline frame inset from the viewport, and the vertical
 * rails at the left edge.
 *
 * Both are fixed, decorative and non-interactive. The frame is what makes the
 * page read as an instrument plate rather than a document — it costs one
 * element and one border.
 */
export function Chrome({ rails = true }: ChromeProps = {}) {
	return (
		<>
			<div className="vx-grain" aria-hidden="true" />
			<div className="vx-frame" aria-hidden="true" />
			{rails ? (
				<>
					<div className="vx-rail vx-rail--top" aria-hidden="true">
						Alethia Labs
					</div>
					<div className="vx-rail vx-rail--bottom" aria-hidden="true">
						ἀλήθεια
					</div>
				</>
			) : null}
		</>
	);
}
