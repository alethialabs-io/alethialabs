// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The agent policy page's words (AGT-L2 SPEC §3, "Copy and consequences (final)"). Kept apart from
// the component so a test can read the exact sentences the spec signed off, and so each consequence
// line is one function of the CURRENT value — the person reads what will happen, not only what the
// switch is called.
//
// Plain data and pure functions: no React, no server imports.

/** One TTL preset as the button group offers it (spec §3, O5). */
export interface TtlPresetLabel {
	minutes: number;
	label: string;
}

/** The request-lifetime presets, in order, with the default marked as the spec writes it. */
export const TTL_PRESET_LABELS: readonly TtlPresetLabel[] = [
	{ minutes: 15, label: "15 min" },
	{ minutes: 30, label: "30 min" },
	{ minutes: 60, label: "1 hour · default" },
	{ minutes: 240, label: "4 hours" },
	{ minutes: 1440, label: "24 hours" },
];

/** The kill switch's title, which is also its accessible name. */
export function accessTitle(org: string): string {
	return `Let agents work in ${org}`;
}

/** The kill switch's body line. */
export const ACCESS_BODY =
	"When this is on, agents act for the person who connected them, within that person's access and the permissions they granted.";

/**
 * A consequence line: a short lead naming the state ("On.", "Off.", "Available on Enterprise.")
 * and the sentence saying what that state does. The page sets the lead in the primary ink.
 */
export interface Consequence {
	lead: string;
	text: string;
}

/** The lead for a switch's current value. */
function onOff(on: boolean): string {
	return on ? "On." : "Off.";
}

/** The kill switch's consequence line for its current value. */
export function accessConsequence(on: boolean): Consequence {
	return {
		lead: onOff(on),
		text: on
			? "Agents can read and plan. Every deploy and destroy still waits for a person's approval."
			: "Every agent request is refused, including reads. Requests already waiting can't be used. The Alethia CLI and service tokens keep working.",
	};
}

/** "Keep agents off production": its title (and accessible name) and body. */
export const NO_PROD_TITLE = "Keep agents off production";
export const NO_PROD_BODY =
	"Agents can still plan production environments, but only a person in the console can deploy or destroy them.";

/** The no-production switch's consequence line for its current value. */
export function noProdConsequence(on: boolean): Consequence {
	return {
		lead: onOff(on),
		text: on
			? "An agent asking to deploy or destroy production is refused straight away, before anyone is asked. The Alethia CLI and service tokens still request approval as usual."
			: "Agents may ask to deploy or destroy production. A person approves each request.",
	};
}

/** Why the no-production switch is disabled while agent access is off. */
export const NO_PROD_DISABLED_WHILE_OFF = "Turn agent access on to change this.";

/** The request-lifetime row. */
export const TTL_TITLE = "How long a request stays open";
export const TTL_GROUP_LABEL = "Request lifetime";
export const TTL_HINT = "Applies to new requests. Requests already waiting keep their time.";

/** "Require a different person to approve" (Enterprise). */
export const DIFFERENT_APPROVER_TITLE = "Require a different person to approve";
export const DIFFERENT_APPROVER_BODY =
	"The person a request was made for can't approve it. Someone else with deploy access has to.";

/** The different-approver consequence line for the edition and the current value. */
export function differentApproverConsequence(entitled: boolean, on: boolean): Consequence {
	if (!entitled) {
		return {
			lead: "Available on Enterprise.",
			text: "On Community and Pro, the person a request was made for can approve it themselves.",
		};
	}
	return {
		lead: onOff(on),
		text: on
			? "Make sure at least two people have deploy access to each project, or requests there can only be denied."
			: "You can approve requests made by your own agents and CLI.",
	};
}

/** "Allowed agent apps" (Enterprise). */
export const ALLOWED_APPS_TITLE = "Allowed agent apps";
export const ALLOWED_APPS_ANY = "Any app";
export const ALLOWED_APPS_ANY_BODY = "People can connect any MCP app. Each still asks them for permission.";
export const ALLOWED_APPS_LIMIT = "Limit to chosen apps";

/** The section descriptions. */
export const ACCESS_SECTION_DESCRIPTION =
	"Connected agents (Claude Code, Cursor and other MCP apps) and the Alethia assistant.";
export const APPROVALS_SECTION_DESCRIPTION =
	"Applies to every request from the Alethia CLI, connected agents, the Alethia assistant and service tokens.";
export function allowedAppsDescription(org: string): string {
	return `Which MCP apps people in ${org} may connect.`;
}

/** The Enterprise label beside a locked row, and the lock's reason outside Enterprise. */
export const ENTERPRISE_LABEL = "Enterprise";
export const AVAILABLE_ON_ENTERPRISE = "Available on Enterprise";

/**
 * Why an Enterprise row is not editable on Enterprise either: the write path for these two columns
 * arrives with AGT-L14's entitlement (lib/agents/policy.ts states the same bound), so the page shows
 * the stored value and says plainly that it cannot change it yet.
 */
export const ENTERPRISE_NOT_EDITABLE_YET = "This setting can't be changed from the console yet.";

/** The banner shown while agent access is off. */
export const OFF_BANNER_TITLE = "Agent access is off.";
export function offBannerBody(org: string): string {
	return `Connected agents and the Alethia assistant can't read, plan, deploy or destroy anything in ${org}.`;
}
export const TURN_BACK_ON = "Turn back on";

/** The turn-off confirmation (`ConfirmAction level="confirm"`). */
export function turnOffTitle(org: string): string {
	return `Turn off agent access for ${org}?`;
}
/**
 * The confirmation's description: the spec's lead sentence, then its three consequences.
 * `ConfirmAction` at `level: "confirm"` carries one description, so they are joined as sentences.
 */
export const TURN_OFF_DESCRIPTION = [
	"Takes effect immediately for everyone in the organization.",
	"Connected agents and the Alethia assistant are refused every request.",
	"Requests already waiting for approval can't be approved or used.",
	"Connections are kept. Turning access back on restores them.",
].join(" ");
export const TURN_OFF_CONFIRM = "Turn off agent access";
export const TURN_OFF_PENDING = "Turning off…";

/** The read-only alert for a viewer without `org:manage_agents`. */
export const READ_ONLY_TITLE = "You can't change agent settings";
export function readOnlyBody(org: string): string {
	return `Changing them needs the Manage agents permission, which your role in ${org} doesn't include. You can see how ${org} is set up; ask someone who manages roles if you need it.`;
}

/** The failed read. */
export const ERROR_TITLE = "Couldn't load agent settings";
export const ERROR_BODY = "Your current settings still apply. Try again in a moment.";

/** The refused read: the viewer no longer holds `org:view` here. */
export const REFUSED_TITLE = "Agent settings aren't available";
export const REFUSED_BODY =
	"You're not a member of this organization any more, or your access changed. Reload the page, or choose another organization.";

/** The toast after each kind of change. */
export function savedMessage(change: {
	agentAccessEnabled?: boolean;
	approvalTtlMinutes?: number;
}): string {
	if (change.agentAccessEnabled === true) return "Agent access is on.";
	if (change.agentAccessEnabled === false) return "Agent access is off.";
	if (change.approvalTtlMinutes !== undefined) return "Saved. New requests stay open for the new time.";
	return "Saved.";
}

/**
 * The footer's first sentence. `when` is already formatted (`formatRelative`); `name` is null when
 * the last changer has no name on record. Null for an org that never changed a default.
 */
export function lastChangedLine(name: string | null, when: string | null): string | null {
	if (when === null) return null;
	return name ? `Last changed by ${name} · ${when}.` : `Last changed ${when}.`;
}
export const ACTIVITY_NOTE = "Every change is recorded in Activity.";
