"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AlertTriangle, KeyRound, RefreshCcw, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { track } from "@/lib/analytics/track";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";

type ChatErrorKind = "missing-key" | "budget" | "network";

/** The AI budget reasons the 402 body carries (mirrors AiBudgetError.reason). */
type BudgetReason = "not_enabled" | "daily" | "weekly" | "out";

/** The parsed shape of the streaming route's 402 body ({error,reason,resetAt,upgradable}). */
interface ParsedBudget {
	message: string;
	reason: BudgetReason;
	resetAt: string | null;
	upgradable: boolean;
}

const BUDGET_REASONS: readonly BudgetReason[] = [
	"not_enabled",
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
		const b = body as Record<string, unknown>;
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
	if (/not configured|AI_GATEWAY_API_KEY/i.test(msg)) return "missing-key";
	if (/budget|quota|credit|reason|upgradable|"error"/i.test(msg)) return "budget";
	return "network";
}

/** Humanize the time until an ISO reset ("2h", "1d", "5m", or "soon"). */
function resetsIn(iso: string | null): string | null {
	if (!iso) return null;
	const ms = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(ms) || ms <= 0) return "soon";
	const h = Math.floor(ms / 3_600_000);
	if (h >= 24) return `${Math.floor(h / 24)}d`;
	if (h >= 1) return `${h}h`;
	return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

const COPY: Record<
	ChatErrorKind,
	{ icon: LucideIcon; title: string; description: string }
> = {
	"missing-key": {
		icon: KeyRound,
		title: "AI is not configured",
		description:
			"Set AI_GATEWAY_API_KEY in your environment to enable the assistant, then retry.",
	},
	budget: {
		icon: AlertTriangle,
		title: "AI limit reached",
		description:
			"You've reached your AI usage limit. It resets on a fixed schedule, or buy credits / upgrade your AI plan to keep going.",
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
 * reason + reset time from the response body and shows the correct CTA — "Upgrade AI plan"
 * when a subscription is needed (`not_enabled`), else "Buy credits" (daily/weekly/out).
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
	const orgSlug = useActiveOrgSlug();
	// Report the surfaced error (kind only — never the raw message) once per occurrence.
	useEffect(() => {
		track("elench_error", { kind });
	}, [kind]);

	const base = COPY[kind];
	const Icon = base.icon;
	// When we parsed a real budget body, use the server's human message + reset time.
	const reset = budget ? resetsIn(budget.resetAt) : null;
	const description = budget
		? `${budget.message}${reset ? ` Resets in ${reset}.` : ""}`
		: base.description;
	// `not_enabled` means "subscribe to an AI plan"; the credit-limit reasons mean "wait or
	// buy credits". Both surfaces live on the billing settings page (AI section).
	const subscribe = budget?.reason === "not_enabled";
	const billingHref = orgSlug ? `/${orgSlug}/settings/billing` : null;

	return (
		<Alert className="rounded-none">
			<Icon />
			<AlertTitle>{base.title}</AlertTitle>
			<AlertDescription>
				<p>{description}</p>
				<div className="mt-2 flex flex-wrap gap-2">
					{budget && billingHref && (
						<Button
							asChild
							variant="outline"
							size="sm"
							className="rounded-none"
						>
							<Link href={billingHref}>
								{subscribe ? "Upgrade AI plan" : "Buy credits"}
							</Link>
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
		</Alert>
	);
}
