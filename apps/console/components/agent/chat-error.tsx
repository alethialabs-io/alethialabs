"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AlertTriangle, KeyRound, RefreshCcw, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { track } from "@/lib/analytics/track";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";

type ChatErrorKind = "missing-key" | "budget" | "network";

/**
 * Classify a `useChat` error into a UI-actionable kind. The AI SDK sets
 * `error.message` to the streaming route's response body: our 503 says
 * "AI is not configured…", the 402 budget response is a JSON blob with a `reason`,
 * and a dropped fetch throws a generic `TypeError`. Everything else falls to network.
 */
function classify(error: Error): ChatErrorKind {
	const msg = error.message ?? "";
	if (/not configured|AI_GATEWAY_API_KEY/i.test(msg)) return "missing-key";
	if (/budget|quota|credit|reason|upgradable|"error"/i.test(msg)) return "budget";
	return "network";
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
			"This request was blocked by your plan's AI budget. It resets on your billing cycle, or upgrade to raise the limit.",
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
 * missing gateway key reads as setup rather than failure, and ALWAYS offers a Retry
 * that re-runs the last turn (`regenerate`). Replaces the former dead-end error box.
 */
export function ChatError({
	error,
	onRetry,
}: {
	error: Error;
	onRetry?: () => void;
}) {
	const kind = classify(error);
	// Report the surfaced error (kind only — never the raw message) once per occurrence.
	useEffect(() => {
		track("elench_error", { kind });
	}, [kind]);
	const { icon: Icon, title, description } = COPY[kind];
	return (
		<Alert className="rounded-none">
			<Icon />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>
				<p>{description}</p>
				{onRetry && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-2 gap-1.5 rounded-none"
						onClick={onRetry}
					>
						<RefreshCcw className="h-3 w-3" />
						Retry
					</Button>
				)}
			</AlertDescription>
		</Alert>
	);
}
