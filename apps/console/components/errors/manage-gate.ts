// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The write side of permission-denied (CON-SM4, spec §4.5). The read side is `RegionRefusal`: the
// viewer may not SEE the thing. This is the other half: the viewer sees it and may not CHANGE it.
//
// The contract has two parts:
//   · every list or settings read answers `canManage: boolean` for the viewer, decided on the
//     server with the same question the write itself asks;
//   · a control the viewer cannot use is rendered DISABLED with its reason
//     (`DisabledReason` from `@repo/ui/disabled-reason`, or an item's `disabledReason`). It is not
//     hidden without explanation, and it is not left enabled to fail with a toast.
// `manageReason` is the one place the reason's words are decided, so two pages cannot say it
// differently.

/** What a list or settings read carries about the viewer's write side. */
export interface ManageRead {
	/** Whether this viewer may change what the read returned. */
	canManage: boolean;
}

/** The reason on a control whose read has answered `canManage: false`. */
export const MANAGE_DENIED_REASON =
	"Your role in this organization doesn't allow this. Ask an owner or admin.";

/** The reason on a control whose read has not answered yet. */
export const MANAGE_PENDING_REASON = "Checking your access.";

/**
 * Why the viewer cannot use a control that changes what `read` returned, or `null` when they can.
 *
 * Three answers, because the read has three states: no answer yet is {@link MANAGE_PENDING_REASON}
 * (the control stays disabled until the server has said yes, so it is never enabled and then
 * refused), `canManage: false` is {@link MANAGE_DENIED_REASON}, and `canManage: true` is `null`.
 *
 * @example
 * <DisabledReason reason={manageReason(settings.data)}>
 *   <Button onClick={openCreate}>Add channel</Button>
 * </DisabledReason>
 */
export function manageReason(read: ManageRead | null | undefined): string | null {
	if (read === null || read === undefined) return MANAGE_PENDING_REASON;
	return read.canManage ? null : MANAGE_DENIED_REASON;
}
