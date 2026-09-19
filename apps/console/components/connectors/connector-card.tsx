"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { connectorState } from "@/components/connectors/connectors-query";
import { Button } from "@repo/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { useId } from "react";

interface ConnectorCardProps {
	integration: ConnectorWithConnection;
	/** Whether the current member may add/edit connections. */
	canManage: boolean;
	/** Connect (or, for a connected cloud, "add another account"). */
	onConnect: () => void;
	/** Open the manage sheet (connected connectors). */
	onManage: () => void;
	/** Re-run the verification for a failed cloud connector (no credential re-entry). */
	onReverify?: () => void;
	/**
	 * False when this instance isn't configured to support this provider's connect flow — a managed
	 * cloud missing platform creds, or a git provider with no registered OAuth app. The tile then
	 * says "not enabled on this instance" instead of offering a doomed connect.
	 */
	platformConfigured?: boolean;
	isConnecting?: boolean;
	/**
	 * Pick mode (create-project cloud picker): a connected, healthy card becomes a radio-style pick
	 * target — the whole card selects instead of offering Manage. Backward-compatible: off by default,
	 * so the connectors page renders identically.
	 */
	selectable?: boolean;
	selected?: boolean;
	onSelect?: () => void;
}

/**
 * One connector tile — matches the grayscale `.conn` card in the connectors design:
 * a logo, name + description, a fill/outline status dot, a mono meta row (account
 * count · auth method), and a Manage/Connect action gated by `canManage`.
 */
export function ConnectorCard({
	integration,
	canManage,
	onConnect,
	onManage,
	onReverify,
	platformConfigured = true,
	isConnecting,
	selectable = false,
	selected = false,
	onSelect,
}: ConnectorCardProps) {
	// Ids for the two nodes the pick's accessible DESCRIPTION is built from. See the pick-mode
	// block on the root element below for why a description is needed at all.
	const uid = useId();
	const descId = `${uid}-desc`;
	const metaId = `${uid}-meta`;
	const isConnected = integration.connected;
	// The status wording and the filter bucket both come from `connectorState` — one ladder, so
	// a tile can never say something the Status facet disagrees with.
	const state = connectorState(integration, platformConfigured);
	// "Coming soon" only when NOT already connected. A connector can be marked coming_soon (e.g. DO/Civo
	// lack provisioning templates) yet still have a live account from before — that account must keep
	// its Manage → disconnect path, so a connected one is treated as a normal connection everywhere.
	const isComingSoon = state.health === "coming_soon";
	// A coming-soon card steps its description down one ink tier and keeps its name at full
	// strength; its state label already says "Coming soon" in words. It is NOT a blanket
	// `opacity-50` on the card — that dimmed the `text-foreground` name to 3.6:1 and the
	// `--muted-foreground` copy to 2.3:1, and at α=0.5 over the page background not even pure
	// black reaches 4.5:1 (#4197). The same step-down as `connector-row.tsx`'s `secondaryInk`,
	// because THIS is the view `/[org]/~/connectors` renders by default (`connectors-page.tsx`
	// opens on `card`), so it is the one the audit scores.
	const secondaryInk = isComingSoon ? "text-text-tertiary" : "text-muted-foreground";
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	// A managed cloud missing platform creds, or a git provider with no registered OAuth app: a
	// connect can only fail, so the tile is honest about it (self-hosters: see the docs to enable).
	const platformUnavailable = state.health === "unavailable";
	const needsReconnection =
		integration.token_health === "expired" ||
		integration.token_health === "refresh_failed";
	const cloudFailed = integration.cloud_health === "failed";
	const cloudTesting = integration.cloud_health === "testing";
	const accountCount = integration.accounts?.length ?? 0;
	// A connected, healthy card is a pick target in pick mode (the whole card selects).
	const isPick =
		selectable &&
		isConnected &&
		!isComingSoon &&
		!platformUnavailable &&
		!needsReconnection &&
		!cloudFailed &&
		!cloudTesting;

	return (
		// THE PICK IS A CONTROL, NOT A BARE `<div onClick>` (#4625).
		//
		// In pick mode this card WAS operable by pointer only: `onClick` with no `role`, no
		// `tabIndex` and no key handling, and a check indicator that was an `aria-hidden` span.
		// Choosing a cloud is the FIRST REQUIRED STEP of creating a project, so a keyboard or
		// screen-reader user could not create one at all (WCAG 2.1.1). The four pick attributes
		// below sit behind the existing `isPick` predicate deliberately — `isPick` is a
		// six-condition question and a second copy of it in `create-project/cloud-picker.tsx`
		// would be the copy that never gets the fix.
		//
		// WHY `role="button"` AND NOT `radio`. A radio needs a `radiogroup` parent, and the picker's
		// container is a `group` — deliberately, because a radio may own no interactive descendants
		// while an UNCONNECTED tile renders a Connect button inside itself, so a container-level
		// `radiogroup` would put every tile under a role its unconnected members cannot take
		// (#4269). `button` + `aria-pressed` says "chosen" and needs no parent role.
		//
		// (The `nested-interactive` half of that argument does NOT apply to the role BELOW, which
		// rides behind `isPick` and so never lands on a tile that offers Connect. Measured: a
		// pick-mode tile has zero interactive descendants — the tooltip trigger renders a plain
		// `<div>` with no role and no tabindex. The `radiogroup` parent is the binding reason.)
		//
		// WHY THE TILE AND NOT A NATIVE `<button>` AROUND IT. `<button>`'s content model is phrasing
		// content and this card's body is flow content (nested layout `<div>`s and a `<p>`); the same
		// JSX also renders the connectors page, where the root hosts real `<button>`s on its other
		// branches. `role="button"` on the existing element is the shape that works for both.
		//
		// WHY `aria-describedby`. `button` is CHILDREN-PRESENTATIONAL in ARIA: the card's body stops
		// being content and collapses into the name. Measured on this tree, a bare `role="button"`
		// computed the name "AWS AWS Amazon Web Services. 1 accountConnected" — one run-on string
		// with the status welded to the account count. Naming the control explicitly and pointing
		// the description at the two nodes that carry the copy and the state gives them back as a
		// description. Same remedy, and the same reason, as `create-project/start-from-scratch-cards.tsx`.
		<div
			onClick={isPick ? onSelect : undefined}
			role={isPick ? "button" : undefined}
			tabIndex={isPick ? 0 : undefined}
			// Icon-only in effect — the visible distinguishing text is the cloud's name, and the
			// verb matches this file's other five controls (Connect / Manage / Re-verify / Reconnect
			// all read "<verb> <connector>"). WCAG 2.5.3 holds: the visible name is a substring.
			aria-label={isPick ? `Select ${integration.name}` : undefined}
			aria-describedby={isPick ? `${descId} ${metaId}` : undefined}
			// The selected state was carried by border colour ALONE. `aria-pressed` is the same
			// state a screen reader can hear; `aria-checked` would require the radio role above.
			aria-pressed={isPick ? selected : undefined}
			onKeyDown={
				isPick
					? (e) => {
							// Self-activation only. The pick branch renders no interactive descendant
							// today, but a handler that fires on a bubbled key from one later would
							// select the tile while the user was operating something inside it.
							if (e.target !== e.currentTarget) return;
							if (e.key !== "Enter" && e.key !== " ") return;
							// Space scrolls the page otherwise, and a `role="button"` owes BOTH keys
							// (ARIA APG) — Space is the pick affordance the console already uses.
							e.preventDefault();
							onSelect?.();
						}
					: undefined
			}
			className={cn(
				"flex flex-col gap-3 rounded-xl border bg-background p-4 shadow-sm transition-colors",
				isComingSoon
					? "border-border/50"
					: selected
						? "border-foreground ring-1 ring-foreground"
						: "border-border/60 hover:border-border",
				// A sighted keyboard user has to be able to see WHICH cloud is about to be picked,
				// so the whole tile carries the focus ring — the same treatment as the console's
				// other card-shaped pick, `design-project/canvas/inspector/radio-card-group.tsx`.
				isPick &&
					"cursor-pointer focus-visible:outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
			)}
		>
			<div className="flex items-start gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 p-1.5">
					{isGit ? (
						<GitProviderIcon
							provider={integration.slug}
							size={22}
							mono={!isConnected}
						/>
					) : (
						<ConnectorIcon
							src={integration.icon_url}
							name={integration.name}
							size={24}
							mono={!isConnected}
						/>
					)}
				</div>
				<div className="min-w-0 flex-1">
					{/* Two lines, not a wider clamp: at the 280px grid minimum a single truncated line
					    ate the identity of exactly the connectors that need it most — "GitHub Enterprise
					    Contai…", "Amazon ECR (cross-acco…", "Azure Container Registry …". Names longer
					    than two lines still clamp, so the tooltip carries the full name either way. */}
					<Tooltip>
						<TooltipTrigger
							render={
								<div className="line-clamp-2 text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]">
									{integration.name}
								</div>
							}
						/>
						<TooltipContent className="max-w-[240px]">
							{integration.name}
						</TooltipContent>
					</Tooltip>
					{/* The id is on the description, NOT on the TooltipTrigger above it: base-ui's
					    trigger stamps its own `id` on whatever element it renders (to wire the
					    popup's `aria-describedby`), so an id set there is overwritten. */}
					<p
						id={descId}
						className={cn("mt-0.5 line-clamp-2 text-xs leading-snug", secondaryInk)}
					>
						{integration.description}
					</p>
				</div>
				{/* status dot — filled when connected, outline otherwise */}
				<span
					className={cn(
						"mt-1 size-2.5 shrink-0 rounded-full",
						isConnected
							? "bg-foreground ring-4 ring-muted/60"
							: "border-[1.5px] border-border",
					)}
					aria-hidden
				/>
			</div>

			<div className="mt-auto flex items-start justify-between gap-2 border-t border-border/40 pt-3">
				{/* Wraps rather than truncates. "Verification failed" used to render as
				    "Verification…" on a Hetzner tile — a clipped status is worse than a taller
				    card, because the clipped half is the part that says what went wrong. */}
				<div
					id={metaId}
					className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-ui-2xs leading-tight text-muted-foreground"
				>
					{isCloud && isConnected && (
						<span className="rounded-full border border-border/60 px-1.5 py-0.5">
							{accountCount} {accountCount === 1 ? "account" : "accounts"}
						</span>
					)}
					{integration.scope === "org" && !isCloud && isConnected && (
						<span className="rounded-full border border-border/60 px-1.5 py-0.5">
							Org
						</span>
					)}
					<span className={cn(state.destructive && "text-destructive")}>
						{state.label}
					</span>
				</div>

				{isComingSoon ? null : platformUnavailable ? (
					<span
						title={
							isGit
								? "This git provider has no OAuth app configured on this instance. See the docs to enable it."
								: "This cloud needs Alethia platform credentials, which aren't configured on this instance. See the docs to enable managed cloud connections."
						}
						className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground"
					>
						Unavailable
					</span>
				) : isPick ? (
					// Pick mode: a radio-style indicator; the whole card is the control. It stays
					// `aria-hidden` on purpose — the card's `aria-pressed` already says whether this
					// cloud is chosen, and a second announcement of the same state is noise.
					<span
						className={cn(
							"grid size-[18px] shrink-0 place-items-center rounded-full border",
							selected
								? "border-foreground bg-foreground text-background"
								: "border-border text-transparent",
						)}
						aria-hidden
					>
						<Check className="size-3" />
					</span>
				) : isConnected && needsReconnection && canManage ? (
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						// The board renders one of these per connector and the visible word is the
						// same on every one of them — 29 buttons reading "Connect", one "Manage" per
						// connected connector. That is not only a Playwright strict-mode problem: a
						// screen-reader user tabbing the grid hears "Connect, button" 29 times with
						// nothing to tell them apart, because the name sits in the CARD, not in the
						// control. `aria-label` puts the connector's name INTO the control's
						// accessible name; the visible word is unchanged and stays a prefix of it,
						// so WCAG 2.5.3 (Label in Name) still holds for voice control.
						aria-label={`Reconnect ${integration.name}`}
						disabled={isConnecting}
						onClick={onConnect}
					>
						{isConnecting ? (
							<Loader2 className="mr-1 size-3.5 animate-spin" />
						) : (
							<RefreshCw className="mr-1 size-3.5" />
						)}
						Reconnect
					</Button>
				) : isConnected ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2.5 text-xs"
						aria-label={`Manage ${integration.name}`}
						onClick={onManage}
					>
						Manage
					</Button>
				) : cloudTesting ? (
					<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
				) : cloudFailed && canManage ? (
					// Manage sits alongside Re-verify deliberately: re-verifying a connection whose stored
					// credentials are simply WRONG will fail forever, so the sheet — where the account can be
					// corrected or removed — has to be reachable from here. Without it a bad connect wedged.
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2.5 text-xs"
							aria-label={`Manage ${integration.name}`}
							onClick={onManage}
						>
							Manage
						</Button>
						<Button
							size="sm"
							className="h-7 px-2.5 text-xs"
							aria-label={`Re-verify ${integration.name}`}
							disabled={isConnecting}
							onClick={onReverify}
						>
							{isConnecting ? (
								<Loader2 className="mr-1 size-3.5 animate-spin" />
							) : (
								<RefreshCw className="mr-1 size-3.5" />
							)}
							Re-verify
						</Button>
					</div>
				) : canManage ? (
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						aria-label={`Connect ${integration.name}`}
						disabled={isConnecting}
						onClick={onConnect}
					>
						{isConnecting && <Loader2 className="mr-1 size-3.5 animate-spin" />}
						Connect
					</Button>
				) : null}
			</div>
		</div>
	);
}
