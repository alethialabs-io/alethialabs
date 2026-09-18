// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Grayscale-first status marks for the Evidence surface. Meaning is carried by the icon +
// label; `bad` is the only tone painted with `destructive` (the brightest ink in the
// grayscale system) so the eye lands on what needs attention. The honest unknown states
// (Not verified / Not evaluable / Not scanned) are first-class — never a default-green.

import {
	ArrowRight,
	CheckCircle2,
	ChevronDown,
	Clock,
	Download,
	FileCheck2,
	FileMinus2,
	Folder,
	Layers,
	Minus,
	RotateCw,
	ScrollText,
	Search,
	ShieldAlert,
	ShieldCheck,
	ShieldQuestion,
	TriangleAlert,
	X,
} from "lucide-react";
import type {
	EvidenceDrift,
	EvidenceSecurity,
	EvidenceVerify,
} from "@/lib/queries/evidence";
import type { Tone } from "./evidence-derive";
import { CLOUD_FILTER_VALUES } from "./evidence-query";

const KNOWN_CLOUDS = new Set<string>(CLOUD_FILTER_VALUES);

/** True when the provider string is a cloud we render a real logo for. */
export function isKnownCloud(provider: string | null): provider is string {
	return provider !== null && KNOWN_CLOUDS.has(provider);
}

/** Named icon keys the derive layer emits, mapped to lucide components here. */
export type IconKey =
	| "shield-check"
	| "shield-alert"
	| "triangle-alert"
	| "shield-question"
	| "file-check"
	| "file-minus"
	| "minus"
	| "clock"
	| "download"
	| "arrow-right"
	| "layers"
	| "folder"
	| "scroll"
	| "rotate"
	| "check-circle"
	| "chevron-down"
	| "search"
	| "x";

const ICONS: Record<IconKey, typeof ShieldCheck> = {
	"shield-check": ShieldCheck,
	"shield-alert": ShieldAlert,
	"triangle-alert": TriangleAlert,
	"shield-question": ShieldQuestion,
	"file-check": FileCheck2,
	"file-minus": FileMinus2,
	minus: Minus,
	clock: Clock,
	download: Download,
	"arrow-right": ArrowRight,
	layers: Layers,
	folder: Folder,
	scroll: ScrollText,
	rotate: RotateCw,
	"check-circle": CheckCircle2,
	"chevron-down": ChevronDown,
	search: Search,
	x: X,
};

/** Renders a named icon at a given pixel size. */
export function EvIcon({
	name,
	className,
	size = 14,
}: {
	name: IconKey;
	className?: string;
	size?: number;
}) {
	const Cmp = ICONS[name];
	return <Cmp width={size} height={size} className={className} />;
}

/**
 * Tone → text color utility (grayscale; `bad` → destructive).
 *
 * `muted` IS NOT `disabled`. It used to be `text-text-disabled`, and that tier is reserved for a
 * control WCAG 1.4.3 exempts because it is inactive — `--text-disabled` is `--gray-400`, 1.95:1 on
 * `--surface` and 1.77:1 on `--surface-sunken` in the light theme, 2.48:1 / 2.64:1 in the dark one,
 * against a 4.5:1 bar. What `muted` actually paints is `verifyMark`/`driftMark`/`securityMark`/
 * `receiptMark`'s "Not verified" / "Not scanned": the ANSWER to the column's question on the page
 * whose whole job is to say what is and is not proven. Nothing about it is disabled, so it takes
 * the dimmest tier that is still readable — `--text-tertiary` clears the bar on every surface token
 * in both themes (worst case 4.73:1, dark `--surface-raised`/`--surface-muted`). #4612.
 *
 * It now shares a tier with `unknown`, and that is the honest outcome rather than a collision to
 * design around: `muted` and `unknown` are both "we do not know", and the four named tiers hold no
 * fifth rung between tertiary and disabled. An alpha would be that fifth rung and is banned —
 * `pnpm check:shared-surface`'s `ink_alpha` rule, #4197. The ICON and the LABEL still separate the
 * two marks, so nothing that was said by colour alone is lost.
 */
export const TONE_TEXT: Record<Tone, string> = {
	good: "text-text-secondary",
	warn: "text-text-secondary",
	bad: "text-destructive",
	unknown: "text-text-tertiary",
	muted: "text-text-tertiary",
};

/** Tone → segmented-bar fill. `bad` is brightest (draws the eye); healthy stays calm. */
export const TONE_BAR: Record<Tone, string> = {
	bad: "bg-destructive",
	warn: "bg-text-secondary",
	good: "bg-text-tertiary",
	unknown: "bg-border-strong",
	muted: "bg-border",
};

/** A rendered status: an icon key, a short label, and a tone. */
export interface Mark {
	iconKey: IconKey;
	label: string;
	tone: Tone;
}

/** Verify verdict → mark. Null verify (never checked) is an honest muted "Not verified". */
export function verifyMark(verify: EvidenceVerify | null): Mark {
	if (!verify)
		return { iconKey: "shield-question", label: "Not verified", tone: "muted" };
	switch (verify.verdict) {
		case "pass":
			return { iconKey: "shield-check", label: "Verified", tone: "good" };
		case "warn":
			return { iconKey: "triangle-alert", label: "Warnings", tone: "warn" };
		case "fail":
			return { iconKey: "shield-alert", label: "Failing", tone: "bad" };
		case "not_evaluable":
			return {
				iconKey: "shield-question",
				label: "Not evaluable",
				tone: "unknown",
			};
	}
}

/** Drift posture → mark. Null drift (never scanned) is an honest muted "Not scanned". */
export function driftMark(drift: EvidenceDrift | null): Mark {
	if (!drift)
		return { iconKey: "shield-question", label: "Not scanned", tone: "muted" };
	if (drift.inSync)
		return { iconKey: "shield-check", label: "In sync", tone: "good" };
	return {
		iconKey: "triangle-alert",
		label: `${drift.drifted} drifted`,
		tone: "bad",
	};
}

/** Security posture → mark. `scanned=false` is "Not scanned", never a misleading all-clear. */
export function securityMark(security: EvidenceSecurity | null): Mark {
	if (!security?.scanned)
		return { iconKey: "shield-question", label: "Not scanned", tone: "muted" };
	if (security.critical > 0)
		return {
			iconKey: "shield-alert",
			label: `${security.critical} critical`,
			tone: "bad",
		};
	if (security.high > 0)
		return {
			iconKey: "triangle-alert",
			label: `${security.high} high`,
			tone: "warn",
		};
	if (security.medium + security.low > 0)
		return {
			iconKey: "shield-check",
			label: `${security.medium + security.low} low`,
			tone: "unknown",
		};
	return { iconKey: "shield-check", label: "Clean", tone: "good" };
}

/** Receipt state → mark: signed / unsigned / none. */
export function receiptMark(verify: EvidenceVerify | null): Mark {
	const receipt = verify?.receipt;
	if (!receipt) return { iconKey: "minus", label: "—", tone: "muted" };
	if (receipt.algorithm === "ed25519") {
		// A receipt anchored in a transparency log (#885) is the strongest state — offline,
		// third-party-verifiable proof of existence — so it outranks a plain signed receipt.
		if (receipt.rekor) return { iconKey: "shield-check", label: "Anchored", tone: "good" };
		return { iconKey: "file-check", label: "Signed", tone: "good" };
	}
	return { iconKey: "file-minus", label: "Unsigned", tone: "unknown" };
}

/**
 * Stage text weight — production carries the most ink (plain mono text, no chip).
 *
 * LEFT ON `text-text-disabled` for the `default` rung, deliberately, and #4612 does not name it.
 * This is a three-rung EMPHASIS LADDER (production → staging → everything else), not a tier picked
 * for one string: collapsing its bottom rung to tertiary makes `development` and `staging` the same
 * ink and is a design decision nobody has recorded. It is also the one site in this directory that
 * only renders inside the drawer, which the a11y sweep does not open, so nothing measured it. Its
 * ladder wants its own issue and its own ruling — not a sweep of the token.
 */
export function stageTextClass(stage: string): string {
	switch (stage) {
		case "production":
			return "text-text-secondary";
		case "staging":
			return "text-text-tertiary";
		default:
			return "text-text-disabled";
	}
}

/** Drift-kind → tone (deleted is the sharpest divergence). */
export function kindTone(kind: string): Tone {
	if (kind === "deleted") return "bad";
	if (kind === "modified") return "warn";
	return "unknown";
}
