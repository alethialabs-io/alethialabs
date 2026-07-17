"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asRecord } from "@/lib/records";
import { AlertTriangle, KeyRound, RefreshCcw, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { getAiUsageSummary } from "@/app/server/actions/billing";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { UpgradeAiSheet } from "@/components/billing/upgrade-ai-sheet";
import { formatCountdown } from "@/lib/billing/ai-usage-format";
import { track } from "@/lib/analytics/track";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";

type ChatErrorKind = "missing-key" | "budget" | "network";

/** The AI budget reasons the 402 body carries (mirrors AiBudgetError.reason; "daily" is
 *  the pre-session-window legacy alias, accepted from in-flight old responses). */
type BudgetReason = "not_enabled" | "session" | "daily" | "weekly" | "out";

/** The parsed shape of the streaming route's 402 body ({error,reason,resetAt,upgradable}). */
interface ParsedBudget {
	message: string;
	reason: BudgetReason;
	resetAt: string | null;
	upgradable: boolean;
}

const BUDGET_REASONS: readonly BudgetReason[] = [
	"not_enabled",
	"session",
	"daily",
	"weekly",
	"out",
];

/**
 * Parse a `useChat` error whose `message` is the streaming route's 402 JSON body
 * ({error, reason, resetAt, upgradable}). Returns the structured budget info, or null if
 * the message isn't our budget JSON (so the caller falls back to regex classification).
 */
function parseBudget(error: Error): ParsedBudget | null {
	const raw = error.message ?? "";
	if (!raw.trim().startsWith("{")) return null;
	try {
		const body: unknown = JSON.parse(raw);
		if (typeof body !== "object" || body === null) return null;
		const b = asRecord(body);
		if (typeof b.reason !== "string") return null;
		if (!BUDGET_REASONS.includes(b.reason as BudgetReason)) return null;
		return {
			message: typeof b.error === "string" ? b.error : "AI limit reached.",
			reason: b.reason as BudgetReason,
			resetAt: typeof b.resetAt === "string" ? b.resetAt : null,
			upgradable: b.upgradable === true,
		};
	} catch {
		return null;
	}
}

/**
 * Classify a `useChat` error into a UI-actionable kind. The AI SDK sets `error.message`
 * to the streaming route's response body: our 503 says "AI is not configured…", the 402
 * budget response is a JSON blob with a `reason` (parsed by `parseBudget`), and a dropped
 * fetch throws a generic `TypeError`. Everything else falls to network.
 */
function classify(error: Error): ChatErrorKind {
	if (parseBudget(error)) return "budget";
	const msg = error.message ?? "";
	if (/not configured|ANTHROPIC_API_KEY/i.test(msg)) return "missing-key";
	if (/budget|quota|credit|reason|upgradable|"error"/i.test(msg)) return "budget";
	return "network";
}

/** Humanize the time until an ISO reset ("Resets in 4 hr 48 min."), or null when unknown. */
function resetsIn(iso: string | null): string | null {
	if (!iso) return null;
	const ms = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(ms)) return null;
	if (ms <= 0) return "soon";
	return `in ${formatCountdown(ms)}`;
}

const COPY: Record<
	ChatErrorKind,
	{ icon: LucideIcon; title: string; description: string }
> = {
	"missing-key": {
		icon: KeyRound,
		title: "AI is not configured",
		description:
			"Set ANTHROPIC_API_KEY in your environment to enable the assistant, then retry.",
	},
	budget: {
		icon: AlertTriangle,
		title: "AI limit reached",
		description:
			"You've reached your AI usage limit. It frees up as the window rolls, or upgrade your AI plan to keep going.",
	},
	network: {
		icon: WifiOff,
		title: "The assistant hit an error",
		description:
			"The request didn't complete — this is usually a transient network or model error. Retry to run it again.",
	},
};

/**
 * The transcript's error affordance. Kind-aware (missing-key / budget / network) so a
 * missing gateway key reads as setup rather than failure, and ALWAYS offers a Retry that
 * re-runs the last turn (`regenerate`). For the AI-budget (402) case it parses the real
 * reason + reset time from the response body and shows the tier-aware CTA: top-up packs
 * are PAID-plan-only, so a hit limit offers "Buy credits" only once a best-effort summary
 * fetch confirms a paid tier — free (or unknown) tiers get "Upgrade AI plan".
 */
export function ChatError({
	error,
	onRetry,
}: {
	error: Error;
	onRetry?: () => void;
}) {
	const kind = classify(error);
	const budget = kind === "budget" ? parseBudget(error) : null;
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [creditsOpen, setCreditsOpen] = useState(false);
	// A budget error means a limit is hit — whether "Buy credits" applies depends on the
	// tier (packs are paid-only). Best-effort: default to the upgrade CTA until known.
	const [paidTier, setPaidTier] = useState(false);
	// Report the surfaced error (kind only — never the raw message) once per occurrence.
	useEffect(() => {
		track("elench_error", { kind });
	}, [kind]);
	useEffect(() => {
		if (kind !== "budget") return;
		let alive = true;
		getAiUsageSummary()
			.then((s) => alive && setPaidTier(s.tier !== "ai_free"))
			.catch(() => {
				/* best-effort — unknown tier keeps the upgrade CTA */
			});
		return () => {
			alive = false;
		};
	}, [kind]);

	const base = COPY[kind];
	const Icon = base.icon;
	// When we parsed a real budget body, use the server's human message + reset time.
	const reset = budget ? resetsIn(budget.resetAt) : null;
	const description = budget
		? `${budget.message}${reset ? ` Resets ${reset}.` : ""}`
		: base.description;
	// `not_enabled` always means "subscribe to an AI plan"; a hit limit offers packs only
	// on a paid tier (free orgs can't top up — the upgrade IS their next step).
	const buyCredits = budget !== null && budget.reason !== "not_enabled" && paidTier;

	return (
		<Alert className="rounded-none">
			<Icon />
			<AlertTitle>{base.title}</AlertTitle>
			<AlertDescription>
				<p>{description}</p>
				<div className="mt-2 flex flex-wrap gap-2">
					{budget && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="rounded-none"
							onClick={() =>
								buyCredits ? setCreditsOpen(true) : setUpgradeOpen(true)
							}
						>
							{buyCredits ? "Buy credits" : "Upgrade AI plan"}
						</Button>
					)}
					{onRetry && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="gap-1.5 rounded-none"
							onClick={onRetry}
						>
							<RefreshCcw className="h-3 w-3" />
							Retry
						</Button>
					)}
				</div>
			</AlertDescription>
			<UpgradeAiSheet open={upgradeOpen} onOpenChange={setUpgradeOpen} />
			<CreditPackDialog
				open={creditsOpen}
				onOpenChange={setCreditsOpen}
				onUpgradeInstead={() => setUpgradeOpen(true)}
			/>
		</Alert>
	);
}
