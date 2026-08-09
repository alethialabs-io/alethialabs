// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page chrome: the hairline frame inset from the viewport, and the vertical
 * rails at the left edge.
 *
 * Both are fixed, decorative and non-interactive. The frame is what makes the
 * page read as an instrument plate rather than a document — it costs one
 * element and one border.
 */
export function Chrome() {
	return (
		<>
			<div className="mkt-grain" aria-hidden="true" />
			<div className="mkt-frame" aria-hidden="true" />
			<div className="mkt-rail mkt-rail--top" aria-hidden="true">
				Alethia Labs
			</div>
			<div className="mkt-rail mkt-rail--bottom" aria-hidden="true">
				ἀλήθεια
			</div>
		</>
	);
}
