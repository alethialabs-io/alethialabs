"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The action a connector offers on the board, decided once.
//
// The card and the table row are one affordance drawn twice, and each used to carry its own copy
// of this ladder. A rule added to one and not the other made what a connector offered depend on
// which view the board happened to be in. Both render this now.

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import type { ConnectorState } from "@/components/connectors/connectors-query";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { INLINE_PX, INLINE_STROKE, MarkGlyph } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import { RefreshCw } from "lucide-react";

interface ConnectorActionProps {
	integration: ConnectorWithConnection;
	/** The connector's resolved state (`connectorState`), computed by the caller that also prints it. */
	state: ConnectorState;
	/** Whether the viewer may add, re-verify or change connections. */
	canManage: boolean;
	/** Whether a NEW connection may be started for this connector (`acceptsNewConnections`). */
	offered: boolean;
	isConnecting?: boolean;
	onConnect: () => void;
	onManage: () => void;
	onReverify?: () => void;
	/** Classes for the wrapper of a two-button action, so a table cell can right-align it. */
	className?: string;
}

/**
 * One connector's action: Connect, Manage, Reconnect, Manage + Re-verify, or none.
 *
 * Every control is named for its connector ("Connect Datadog", not "Connect"). The board renders
 * one per connector and the visible word is the same on all of them, so a screen-reader user
 * tabbing the grid would otherwise hear "Connect, button" once per card with nothing to tell them
 * apart. The visible word stays the first word of the name, so WCAG 2.5.3 (Label in Name) holds.
 *
 * A viewer who may not manage connections still sees Manage, because the sheet is also where a
 * connection is READ. A control that would change something — Connect, Re-verify — is drawn
 * disabled with the reason; it is never hidden without one and never left to fail on click.
 *
 * Connect is not drawn at all for a cloud that takes no new connection (`offered` false). That is
 * not a permission: no one in the organization can start one, so there is nothing to disable.
 */
export function ConnectorAction({
	integration,
	state,
	canManage,
	offered,
	isConnecting,
	onConnect,
	onManage,
	onReverify,
	className,
}: ConnectorActionProps) {
	const isGit = integration.category === "git";
	const isConnected = integration.connected;
	const needsReconnection =
		integration.token_health === "expired" || integration.token_health === "refresh_failed";
	const denied = canManage ? null : MANAGE_DENIED_REASON;

	const manage = (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 px-2.5 text-xs"
			aria-label={`Manage ${integration.name}`}
			onClick={onManage}
		>
			Manage
		</Button>
	);

	if (state.health === "coming_soon") return null;

	if (state.health === "unavailable") {
		// A managed cloud missing platform credentials, or a git provider with no registered OAuth
		// app: a connect can only fail, so the tile says so (self-hosters: see the docs to enable).
		return (
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
		);
	}

	if (isConnected && needsReconnection && canManage) {
		return (
			<Button
				size="sm"
				className="h-7 px-2.5 text-xs"
				aria-label={isConnecting ? `Reconnecting ${integration.name}…` : `Reconnect ${integration.name}`}
				pending={isConnecting}
				onClick={onConnect}
			>
				<RefreshCw className="mr-1 size-3.5" aria-hidden />
				{isConnecting ? "Reconnecting…" : "Reconnect"}
			</Button>
		);
	}

	if (isConnected) return manage;

	if (integration.cloud_health === "testing") {
		// The state label beside it already says "Verifying…", so the inline [·] mark is decorative:
		// a status region here would say the same wait a second time.
		return (
			<MarkGlyph
				width={INLINE_PX}
				height={INLINE_PX}
				bracketStroke={INLINE_STROKE}
				className="text-muted-foreground"
				aria-hidden="true"
			/>
		);
	}

	if (integration.cloud_health === "failed") {
		// Manage sits alongside Re-verify deliberately: re-verifying a connection whose stored
		// configuration is simply WRONG fails every time, so the sheet — where the account can be
		// removed — has to be reachable from here. Without it a bad connect was stuck.
		return (
			<div className={cn("flex items-center gap-1", className)}>
				{manage}
				<DisabledReason reason={denied}>
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						aria-label={isConnecting ? `Re-verifying ${integration.name}…` : `Re-verify ${integration.name}`}
						pending={isConnecting}
						onClick={onReverify}
					>
						<RefreshCw className="mr-1 size-3.5" aria-hidden />
						{isConnecting ? "Re-verifying…" : "Re-verify"}
					</Button>
				</DisabledReason>
			</div>
		);
	}

	if (!offered) return null;

	return (
		<DisabledReason reason={denied}>
			<Button
				size="sm"
				className="h-7 px-2.5 text-xs"
				aria-label={isConnecting ? `Connecting ${integration.name}…` : `Connect ${integration.name}`}
				pending={isConnecting}
				onClick={onConnect}
			>
				{isConnecting ? "Connecting…" : "Connect"}
			</Button>
		</DisabledReason>
	);
}
