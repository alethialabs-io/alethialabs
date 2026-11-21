"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's one disconnect confirmation, and what it says before the button can be pressed.
//
// Disconnecting a cloud account is not one kind of action. With no project on it, it removes a
// stored configuration and nothing else changes. With projects on it, each of them loses the
// account it plans, deploys and destroys through — and the old dialog said "existing resources are
// not affected" in both cases, behind a single click. So this reads which projects use the account
// and puts the answer in front of the person: their names, and a typed confirmation when there are
// any. What it cannot find out it treats as the worse case, not the better one.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	ConfirmAction,
	type ConfirmSeverity,
	type ConfirmableMutation,
} from "@/components/confirm/confirm-action";
import { CLOUD_ACCOUNT, PROJECT } from "@/lib/copy/vocabulary";
import { orpc } from "@/lib/rpc/client";

/** What the dialog is about to remove: a whole connector, or one of a cloud's accounts. */
export interface DisconnectTarget {
	integration: ConnectorWithConnection;
	/** The cloud account to disconnect; absent for a git link or an api_key credential. */
	identityId?: string;
}

/** The most projects the dialog names one by one; the rest are counted. */
export const NAMED_PROJECTS_MAX = 8;

/** What is known about the projects on a cloud account. */
export type AffectedProjects =
	| { kind: "none" }
	| { kind: "some"; names: string[] }
	/** The projects read has not answered, or failed: nothing may be concluded from it. */
	| { kind: "unknown" };

/** The words and the severity of one disconnect confirmation. */
export interface DisconnectCopy {
	description: string;
	severity: ConfirmSeverity;
}

/** What stays true whichever cloud account is disconnected. */
const RESOURCES_UNCHANGED =
	"Resources already running in your cloud are not changed or deleted.";

/**
 * The dialog's description and severity for a cloud account.
 *
 * - No project uses it: a plain confirmation, and the description says so.
 * - Projects use it: destroy-class. Each project is a consequence line (up to
 *   {@link NAMED_PROJECTS_MAX}, then a count), and the account's name has to be typed.
 * - Not known: destroy-class too, with a line saying the check could not be made. An unread list is
 *   not an empty one.
 */
export function cloudDisconnectCopy(accountName: string, affected: AffectedProjects): DisconnectCopy {
	const opening = `This disconnects the ${CLOUD_ACCOUNT.one} ${accountName} and removes its stored configuration.`;
	const until = `Alethia will no longer be able to plan, deploy or destroy with it until you connect it again.`;
	if (affected.kind === "none") {
		return {
			description: `${opening} No ${PROJECT.one} uses it. ${until} ${RESOURCES_UNCHANGED}`,
			severity: { level: "confirm" },
		};
	}
	if (affected.kind === "unknown") {
		return {
			description: `${opening} ${until}`,
			severity: {
				level: "destroy",
				subject: accountName,
				consequences: [
					`Alethia could not check which ${PROJECT.many} use this ${CLOUD_ACCOUNT.one}. Any ${PROJECT.one} that does is left without one and cannot be planned, deployed or destroyed until you choose another.`,
					RESOURCES_UNCHANGED,
				],
			},
		};
	}
	const named = affected.names.slice(0, NAMED_PROJECTS_MAX);
	const rest = affected.names.length - named.length;
	const count = affected.names.length;
	return {
		description: `${opening} ${count === 1 ? `1 ${PROJECT.one} uses` : `${count} ${PROJECT.many} use`} it and ${count === 1 ? "is" : "are"} left without a ${CLOUD_ACCOUNT.one}:`,
		severity: {
			level: "destroy",
			subject: accountName,
			consequences: [
				...named.map(
					(name, index) =>
						// The index keeps two lines apart when two projects share a display name.
						`${index + 1}. ${name} cannot be planned, deployed or destroyed until you choose another ${CLOUD_ACCOUNT.one} for it.`,
				),
				...(rest > 0 ? [`And ${rest} more ${rest === 1 ? PROJECT.one : PROJECT.many}.`] : []),
				RESOURCES_UNCHANGED,
			],
		},
	};
}

/** The dialog's description for a connector that is not a cloud account: always a plain confirmation. */
export function connectorDisconnectCopy(
	integration: Pick<ConnectorWithConnection, "category" | "name">,
): DisconnectCopy {
	return {
		description:
			integration.category === "git"
				? `This unlinks your ${integration.name} account. Alethia can no longer read its repositories until you connect it again.`
				: `This removes the stored credential for the whole organization. ${integration.name} cannot be used until you connect it again.`,
		severity: { level: "confirm" },
	};
}

interface ConnectorsDisconnectDialogProps {
	/** What to disconnect; `null` while the dialog is closed. */
	target: DisconnectTarget | null;
	/** Called when the dialog closes: cancelled, or the disconnect succeeded. */
	onClose: () => void;
	/** The board's disconnect write (`useActionMutation` over the three disconnect actions). */
	mutation: ConfirmableMutation<DisconnectTarget>;
}

/**
 * The disconnect confirmation for whatever `target` names, on `ConfirmAction` (pending, close on
 * success and stay open on failure are the seam's). For a cloud account it reads the
 * organization's projects — the shell already holds that read, so it is normally answered from
 * the cache — and names the ones bound to the account.
 */
export function ConnectorsDisconnectDialog({ target, onClose, mutation }: ConnectorsDisconnectDialogProps) {
	// The last target, kept so the words stay on screen while the dialog closes.
	const [shown, setShown] = useState(target);
	if (target !== null && target !== shown) setShown(target);

	const isCloud = shown?.integration.category === "cloud";
	const identityId = isCloud
		? (shown?.identityId ?? shown?.integration.connection_details?.cloud_identity_id ?? null)
		: null;
	const projects = useQuery(orpc.workspace.projects.queryOptions({ enabled: identityId !== null }));

	if (!shown) return null;

	const { integration } = shown;
	const account = integration.accounts?.find((a) => a.identityId === identityId);
	let copy: DisconnectCopy;
	if (!isCloud) {
		copy = connectorDisconnectCopy(integration);
	} else {
		let affected: AffectedProjects = { kind: "unknown" };
		if (identityId !== null && projects.data !== undefined && !projects.isError) {
			const names = projects.data
				.filter((p) => p.cloud_identity_id === identityId)
				.map((p) => p.project_name);
			affected = names.length > 0 ? { kind: "some", names } : { kind: "none" };
		}
		copy = cloudDisconnectCopy(account?.name ?? integration.name, affected);
	}

	return (
		<ConfirmAction
			open={target !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={`Disconnect ${integration.name}?`}
			description={copy.description}
			confirmLabel="Disconnect"
			pendingLabel="Disconnecting…"
			severity={copy.severity}
			mutation={mutation}
			variables={target}
		/>
	);
}
