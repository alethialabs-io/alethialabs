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

/** Tone → text color utility (grayscale; `bad` → destructive). */
export const TONE_TEXT: Record<Tone, string> = {
	good: "text-text-secondary",
	warn: "text-text-secondary",
	bad: "text-destructive",
	unknown: "text-text-tertiary",
	muted: "text-text-disabled",
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
	if (receipt.algorithm === "ed25519")
		return { iconKey: "file-check", label: "Signed", tone: "good" };
	return { iconKey: "file-minus", label: "Unsigned", tone: "unknown" };
}

/** Stage chip styling — production carries the most weight. */
export function stageChipClass(stage: string): string {
	switch (stage) {
		case "production":
			return "border-border-strong text-text-secondary";
		case "staging":
			return "border-border text-text-tertiary";
		default:
			return "border-border-faint text-text-disabled";
	}
}

/** Drift-kind → tone (deleted is the sharpest divergence). */
export function kindTone(kind: string): Tone {
	if (kind === "deleted") return "bad";
	if (kind === "modified") return "warn";
	return "unknown";
}
