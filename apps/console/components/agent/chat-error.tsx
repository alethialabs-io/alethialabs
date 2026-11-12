"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isEnumMember } from "@/lib/coerce";
import { asRecord } from "@/lib/records";
import {
	AlertTriangle,
	CreditCard,
	Hourglass,
	KeyRound,
	MessageSquareWarning,
	RefreshCcw,
	ShieldAlert,
	TextCursorInput,
	WifiOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { getAiUsageSummary } from "@/app/server/actions/billing";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { UpgradeAiSheet } from "@/components/billing/upgrade-ai-sheet";
import { MESSAGE_TOO_LONG } from "@/lib/ai/message-limits";
import { providerErrorCodeOf } from "@/lib/ai/provider-error";
import { formatCountdown } from "@/lib/billing/ai-usage-format";
import { track } from "@/lib/analytics/track";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";

type ChatErrorKind =
	| "missing-key"
	| "budget"
	| "too-long"
	| "unanswered"
	| "thread-start"
	| "notice"
	| "provider-billing"
	| "provider-auth"
	| "provider-overloaded"
	| "network";

/**
 * Kinds whose Retry cannot help, so none is offered: re-sending an over-limit message is refused
 * again, and a provider account with no credit or a rejected key fails every attempt until an
 * administrator of this deployment fixes it.
 */
const NO_RETRY: ReadonlySet<ChatErrorKind> = new Set<ChatErrorKind>([
	"too-long",
	"provider-billing",
	"provider-auth",
]);

/**
 * A transcript that ENDS on a user turn with no reply after it — found on load, not raised by
 * any request in this session (most often a first turn that failed and was stored by
 * `createThread`). It is its own class so `classify` recognises it by type rather than by its
 * text, and so it is never counted as a fresh `elench_error`: nothing failed while the user
 * watched, and why the original request failed is not known here.
 */
export class UnansweredTurnError extends Error {
	constructor() {
		super("The reply to this message never arrived.");
		this.name = "UnansweredTurnError";
	}
}

/**
 * A conversation's thread could not be created on its first send, so NOTHING was sent: a send
 * without a thread id is a reply that is never stored. Recognised by type like
 * {@link UnansweredTurnError}; its Retry re-attempts the thread before sending. Elench no longer
 * raises it: since ADR 0001 slice 9 a failed first send puts its words back into the box through
 * the drafts store (D11r), with no card of its own. It stays for any surface that still starts a
 * thread before its first send.
 */
export class ThreadStartError extends Error {
	constructor() {
		super("The conversation could not be started.");
		this.name = "ThreadStartError";
	}
}

/**
 * A card whose words the conversation chose, not a failure it classifies: the stale-revision
 * resume of a continuation, or an answer that stopped at a proposal still awaiting its card
 * (ADR 0003 §9.1). Recognised by type; never counted as an `elench_error`.
 */
export class ChatNoticeError extends Error {
	constructor(
		readonly title: string,
		description: string,
	) {
		super(description);
		this.name = "ChatNoticeError";
	}
}

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
		if (!isEnumMember(b.reason, BUDGET_REASONS)) return null;
		return {
			message: typeof b.error === "string" ? b.error : "AI limit reached.",
			reason: b.reason,
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
 * fetch throws a generic `TypeError`. An over-limit message is the routes' 413 body, and a
 * reloaded transcript ending on an unanswered turn is an `UnansweredTurnError`, and a first send
 * whose thread could not be created is a `ThreadStartError`. A provider failure is the stream
 * error text a chat route returned from `lib/ai/provider-error.ts` — matched exactly, and before the
 * budget pattern, because the out-of-credit constant says "credit". Everything else falls to
 * network.
 */
function classify(error: Error): ChatErrorKind {
	if (error instanceof UnansweredTurnError) return "unanswered";
	if (error instanceof ThreadStartError) return "thread-start";
	if (error instanceof ChatNoticeError) return "notice";
	if (parseBudget(error)) return "budget";
	const msg = error.message ?? "";
	// The chat routes' 413 body, matched exactly — it is a shared constant, not prose.
	if (msg === MESSAGE_TOO_LONG) return "too-long";
	const provider = providerErrorCodeOf(msg);
	if (provider && provider !== "network") return provider;
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
	"too-long": {
		icon: TextCursorInput,
		title: "Message too long",
		description: MESSAGE_TOO_LONG,
	},
	unanswered: {
		icon: MessageSquareWarning,
		title: "No reply arrived",
		description:
			"This message was sent, but the reply never arrived. Retry to send it again.",
	},
	"thread-start": {
		icon: MessageSquareWarning,
		title: "Could not start the conversation",
		description:
			"Your message was not sent. It is still in the box below — retry to start the conversation and send it. Closing this chat or reloading discards it.",
	},
	notice: {
		icon: MessageSquareWarning,
		title: "",
		description: "",
	},
	"provider-billing": {
		icon: CreditCard,
		title: "The AI provider account is out of credit",
		description:
			"The model provider account behind this deployment has no credit left. An administrator of this deployment needs to top it up. Retrying does not help until then.",
	},
	"provider-auth": {
		icon: ShieldAlert,
		title: "The AI provider rejected the API key",
		description:
			"The model provider refused this deployment's API key. An administrator of this deployment needs to check the key. Retrying does not help until then.",
	},
	"provider-overloaded": {
		icon: Hourglass,
		title: "The AI provider is busy",
		description:
			"The model provider is busy or is limiting requests. Wait a moment, then retry.",
	},
	network: {
		icon: WifiOff,
		title: "The assistant hit an error",
		description:
			"The request didn't complete — this is usually a transient network or model error. Retry to run it again.",
	},
};

/**
 * The transcript's error affordance. Kind-aware (missing-key / budget / too-long / unanswered /
 * thread-start / provider-billing / provider-auth / provider-overloaded / network) so a missing gateway key reads as setup rather than failure, and
 * offers the caller's Retry (`regenerate` for a turn, a thread re-attempt for thread-start) on
 * every kind but too-long and the two operator-side provider kinds (billing, auth) — re-sending
 * cannot succeed until the message, or the deployment's provider account, changes. A busy
 * provider keeps Retry.
 * For the AI-budget (402) case it parses the real reason + reset time from the response body and
 * shows the tier-aware CTA: top-up packs are PAID-plan-only, so a hit limit offers "Buy credits"
 * only once a best-effort summary fetch confirms a paid tier — free (or unknown) tiers get
 * "Upgrade AI plan".
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
	// Report the surfaced error (kind only — never the raw message) once per occurrence. An
	// unanswered turn is NOT an occurrence: it is a past failure re-read from the stored
	// transcript every time the thread opens, so counting it would inflate the error rate with
	// requests this session never made.
	useEffect(() => {
		if (kind === "unanswered" || kind === "notice") return;
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

	const base =
		error instanceof ChatNoticeError
			? { ...COPY.notice, title: error.title, description: error.message }
			: COPY[kind];
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
					{onRetry && !NO_RETRY.has(kind) && (
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
