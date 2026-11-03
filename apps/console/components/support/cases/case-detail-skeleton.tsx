// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { CaseClosedNotice } from "./case-closed-notice";
import {
	CASE_ATTACHMENTS,
	CASE_ATTACHMENTS_HEADING,
	CASE_ATTACHMENTS_LIST,
	CASE_THREAD,
	CASE_THREAD_CONTENT,
	CASE_THREAD_VIEWPORT,
} from "./case-detail-parts";
import { type CaseShape, type CaseShapeMessage, OPENING_CASE_SHAPE } from "./case-shape";

/**
 * One thread message in the page's geometry: the `Message` column (`max-w-[95%]`, right-aligned for
 * the requester), its label row (an avatar for anyone but the requester, then the name and the
 * time), and the body in `MessageContent`'s box — `w-fit`, `text-sm`, and for the requester the
 * bubble's `px-4 py-3`.
 *
 * The body's TEXT is set inside the placeholder, invisibly, in the paragraphs its markdown renders
 * as (`space-y-4`, as the renderer spaces blocks): the bubble is as wide as its text and as tall as
 * its lines, and only the text itself can say how wide and how many. A placeholder of a fixed size
 * was a 686px-wide, 76px-tall filled block over a 44px one-line bubble (#6354). Unknown text
 * (`paragraphs: null`) is one line at half the column.
 */
function MessageSkeleton({ message }: { message: CaseShapeMessage }) {
	const { fromCustomer, paragraphs } = message;
	return (
		<div className={cn("flex w-full min-w-0 max-w-[95%] flex-col gap-2", fromCustomer && "ml-auto")}>
			<div className={cn("flex items-center gap-2", fromCustomer && "flex-row-reverse")}>
				{!fromCustomer && <Skeleton className="size-6 rounded-none" />}
				<Skeleton className="h-4 w-16 rounded-none" />
				<Skeleton className="h-4 w-32 rounded-none" />
			</div>
			<Skeleton
				className={cn(
					"flex min-w-0 max-w-full flex-col overflow-hidden rounded-none text-sm",
					paragraphs === null ? "w-1/2" : "w-fit",
					fromCustomer && "ml-auto px-4 py-3",
				)}
			>
				<div aria-hidden className="min-w-0 space-y-4 whitespace-normal break-words [overflow-wrap:anywhere]">
					{paragraphs === null ? <p>{" "}</p> : paragraphs.map((p, i) => <p key={i}>{p}</p>)}
				</div>
			</Skeleton>
		</div>
	);
}

/**
 * The case view's loading form — the route's `loading.tsx` (with the case's {@link CaseShape}, read
 * on the server before it draws) and the view's own pending branch (with no data, so
 * {@link OPENING_CASE_SHAPE}) draw this ONE component. It is the page's layout part for part, so the
 * swap to the page moves nothing (#6354, B2):
 *
 * - the header: the back link (its ghost button's `-ml-2` box), the reference, the subject, the
 *   badge line, the lifecycle button — absent on a closed case, as on the page — and the
 *   classification row, a `size="sm"` "Classify" button;
 * - the attachments panel, one row per attachment, when the case has any — the page's own frame;
 * - the conversation, in the page's frame, viewport bound and padding, the page's message column
 *   (`gap-8`), and one {@link MessageSkeleton} per message, newest at the bottom. A thread taller
 *   than the bound is clipped at the top, showing the end, as the page opens scrolled to the end;
 * - the composer — the reply box at its `min-h-24` floor, then the row with the `size="sm"` Send
 *   button, `space-y-1` apart as `CaseComposer` sets them — or, on a closed case, the page's own
 *   closed notice with a placeholder for its reopen button.
 */
export function CaseDetailSkeleton({ shape = OPENING_CASE_SHAPE }: { shape?: CaseShape }) {
	return (
		<div className="flex flex-col gap-6" aria-busy="true">
			{/* Header */}
			<div className="space-y-4">
				<Skeleton className="-ml-2 h-7 w-24" />
				<div className="space-y-2">
					<div className="flex items-start justify-between gap-4">
						<div className="space-y-2">
							<Skeleton className="h-3 w-24" />
							<Skeleton className="h-5 w-64" />
							<div className="flex items-center gap-2">
								<Skeleton className="h-5 w-16 rounded-none" />
								<Skeleton className="h-5 w-14 rounded-none" />
								<Skeleton className="h-3 w-40" />
							</div>
						</div>
						<Skeleton className="h-8 w-24 rounded-md" />
					</div>
					{/* Classification */}
					<Skeleton className="h-8 w-24 rounded-none" />
				</div>
			</div>

			{/* Attachments */}
			{false && shape.attachments > 0 && ( /* M4 */
				<div className={CASE_ATTACHMENTS}>
					<div className={CASE_ATTACHMENTS_HEADING}>
						<Skeleton className="h-4 w-24 rounded-none" />
					</div>
					<ul className={CASE_ATTACHMENTS_LIST}>
						{Array.from({ length: shape.attachments }, (_, i) => (
							<li key={i} className="flex h-5 items-center">
								<Skeleton className="h-3 w-48 rounded-none" />
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Thread */}
			<div className={CASE_THREAD}>
				<div className={cn("flex flex-col overflow-hidden", CASE_THREAD_VIEWPORT)}>
					<div className={cn("flex shrink-0 flex-col gap-8", CASE_THREAD_CONTENT)}>
						{shape.messages.map((message, i) => (
							<MessageSkeleton key={i} message={message} />
						))}
					</div>
				</div>
			</div>

			{/* Composer, or the closed notice in its place */}
			{shape.closed ? (
				<CaseClosedNotice action={<Skeleton className="mt-1 h-8 w-32 rounded-none" />} />
			) : (
				<div className="space-y-1">
					<Skeleton className="h-24 w-full rounded-none" />
					<div className="flex justify-end">
						<Skeleton className="h-8 w-20 rounded-none" />
					</div>
				</div>
			)}
		</div>
	);
}
