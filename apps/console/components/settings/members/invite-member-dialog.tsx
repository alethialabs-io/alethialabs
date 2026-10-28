"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invite teammates to the active organization (Pro — gated by `canOrgInvite`). Supports
// adding several emails at once, each with its own role, validates inline (format, in-batch
// duplicates, already-a-member / already-invited from the live invite context), and shows
// the per-seat cost so the inviter sees the billing impact. Works controlled (`open` /
// `onOpenChange`) or uncontrolled (pass a `trigger`).

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2, UserPlus } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { formatMoney } from "@repo/format";
import { Button } from "@repo/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/dialog";
import { FormControl, FormField, FormItem, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/select";
import { type ActionResult, describeActionError } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { authClient } from "@/lib/auth/client";
import { track } from "@/lib/analytics/track";
import { INVITE_ROLES } from "@/lib/members/roles";
import { useInviteContextQuery } from "@/lib/query/use-members-query";
import { orpc } from "@/lib/rpc/client";
import { viaAuth } from "./auth-action";

interface InviteFormData {
  invites: { email: string; role: string }[];
}

/** Inviteable org roles (owner is the creator, never invited). */
type InviteRole = "admin" | "operator" | "viewer";

/** Narrows a free-form role string to an InviteRole (no unsafe cast); falls back to viewer. */
function toInviteRole(value: string): InviteRole {
  switch (value) {
    case "admin":
    case "operator":
    case "viewer":
      return value;
    default:
      return "viewer";
  }
}

/** What one send of the invite form produced: the addresses invited, and the rows refused. */
interface InviteOutcome {
  sent: string[];
  /** Each refused row's position in the submitted list, with the server's reason. */
  failed: { index: number; message: string }[];
}

/**
 * Invites each row through Better Auth's organization endpoint (the browser's own call, so the ee
 * `beforeCreateInvitation` hook enforces the collaboration gate and the email/alert fire there).
 * Rows are independent — one refused address does not stop the rest — so the outcome lists both.
 */
async function sendInvites(rows: InviteFormData["invites"]): Promise<ActionResult<InviteOutcome>> {
  const outcome: InviteOutcome = { sent: [], failed: [] };
  for (const [index, inv] of rows.entries()) {
    const email = inv.email.trim().toLowerCase();
    const result = await viaAuth(() =>
      authClient.organization.inviteMember({ email, role: toInviteRole(inv.role) }),
    );
    if (result.ok) {
      outcome.sent.push(email);
      track("member_invited", { role: inv.role });
    } else {
      outcome.failed.push({ index, message: describeActionError(result.error) });
    }
  }
  return { ok: true, data: outcome };
}

/** Builds the form schema, flagging emails already taken (member/pending) or duplicated. */
function buildSchema(existing: Set<string>, pending: Set<string>) {
  return z
    .object({
      invites: z
        .array(
          z.object({
            email: z.string().min(1, "Required").email("Enter a valid email"),
            role: z.string().min(1, "Pick a role"),
          }),
        )
        .min(1),
    })
    .superRefine((val, ctx) => {
      const seen = new Set<string>();
      val.invites.forEach((inv, i) => {
        const e = inv.email.trim().toLowerCase();
        if (!e || !inv.email.includes("@")) return;
        const path = ["invites", i, "email"] as const;
        if (existing.has(e))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Already a member",
            path: [...path],
          });
        else if (pending.has(e))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Already invited",
            path: [...path],
          });
        if (seen.has(e))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate email",
            path: [...path],
          });
        seen.add(e);
      });
    });
}

/** Invite a teammate (or several) to the active organization. */
export function InviteMemberDialog({
  onInvited,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  onInvited?: () => void;
  trigger?: ReactElement<Record<string, unknown>>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  // The live invite context (seat figures, taken emails), read over GET each time the dialog is
  // open (#6129) — and refreshed by the `members` hint while it is.
  const { data: ctx } = useInviteContextQuery(open);

  const existing = useMemo(
    () => new Set(ctx?.existingEmails ?? []),
    [ctx?.existingEmails],
  );
  const pending = useMemo(
    () => new Set(ctx?.pendingEmails ?? []),
    [ctx?.pendingEmails],
  );
  const schema = useMemo(
    () => buildSchema(existing, pending),
    [existing, pending],
  );
  const roles = ctx?.roles ?? INVITE_ROLES;

  const form = useForm<InviteFormData>({
    resolver: zodResolver(schema),
    defaultValues: { invites: [{ email: "", role: "viewer" }] },
    mode: "onChange",
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "invites",
  });

  // Reset to a single empty row whenever the dialog is freshly opened.
  useEffect(() => {
    if (open) form.reset({ invites: [{ email: "", role: "viewer" }] });
  }, [open, form]);

  const invite = useActionMutation(sendInvites, {
    // The members table (a new pending row) and this dialog's own taken-email list.
    invalidates: [orpc.members.key()],
    successMessage: (d) =>
      d.sent.length === 0
        ? ""
        : d.sent.length === 1
          ? `Invitation sent to ${d.sent[0]}`
          : `${d.sent.length} invitations sent`,
    onSuccess: (d) => {
      if (d.failed.length === 0) {
        setOpen(false);
        form.reset({ invites: [{ email: "", role: "viewer" }] });
        onInvited?.();
        return;
      }
      // Keep only the refused rows, each with its reason under its own address — a retry then
      // sends exactly those, never re-invites the ones that went.
      const failedAt = new Set(d.failed.map((f) => f.index));
      remove(fields.flatMap((_, i) => (failedAt.has(i) ? [] : [i])));
      d.failed.forEach((f, i) =>
        form.setError(`invites.${i}.email`, { type: "server", message: f.message }),
      );
    },
  });

  const onSubmit = (data: InviteFormData) => {
    if (invite.isPending) return;
    invite.mutate(data.invites);
  };

  // The amount comes through as a `Money` and is rendered by `formatMoney` (#4176 part b). It
  // used to be a bare `ctx.unitAmountUsd` with a literal `$` written in front of it, which is
  // the exact shape `pnpm check:shared-surface` matches — and it went unmatched because a `$`
  // typed into JSX TEXT is not the `` `$${…}` `` template the matcher reads. A EUR org was told
  // its seats cost dollars.
  const seatBanner =
    ctx?.hosted && ctx.unitAmount != null ? (
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {ctx.memberCount} {ctx.memberCount === 1 ? "seat" : "seats"} in use
        </span>{" "}
        · {formatMoney(ctx.unitAmount)}/seat — each new member adds a seat to your
        subscription.
      </p>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite members</DialogTitle>
          <DialogDescription>
            Add one or more teammates — each gets an email to join this
            organization with the role you choose.
          </DialogDescription>
        </DialogHeader>

        {seatBanner}

        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <div className="space-y-2">
              {fields.map((field, i) => (
                <div key={field.id} className="flex items-start gap-2">
                  <FormField
                    control={form.control}
                    name={`invites.${i}.email`}
                    render={({ field: f }) => (
                      <FormItem className="flex-1">
                        <FormControl>
                          <Input
                            aria-label={`Email address ${i + 1}`}
                            type="email"
                            placeholder="teammate@company.com"
                            autoFocus={i === 0}
                            {...f}
                          />
                        </FormControl>
                        <FormMessage className="text-ui-xs" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`invites.${i}.role`}
                    render={({ field: f }) => (
                      <FormItem className="w-32 shrink-0">
                        <Select value={f.value} onValueChange={f.onChange}>
                          <FormControl>
                            {/* The picker carries its own accessible name. Without one the only way
                                to reach it is by position among the dialog's comboboxes, and a
                                spec that says `.first()` is asserting about whichever control
                                happens to be first — a test that keeps passing when the row it
                                meant to read has moved. */}
                            <SelectTrigger
                              aria-label={`Role for invite ${i + 1}`}
                              className="h-9 w-full"
                            >
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {roles.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove"
                    disabled={fields.length === 1}
                    onClick={() => remove(i)}
                    className="h-9 w-9 shrink-0"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => append({ email: "", role: "viewer" })}
              className="gap-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              Add another
            </Button>

            {/* Role legend — what each role grants (descriptions, no overflow). */}
            <ul className="space-y-0.5 border-t pt-2.5 text-ui-xs text-muted-foreground">
              {roles.map((r) => (
                <li key={r.value}>
                  <span className="font-medium text-foreground">{r.label}</span>{" "}
                  — {r.description}
                </li>
              ))}
            </ul>

            <DialogFooter>
              <Button type="submit" disabled={invite.isPending}>
                <UserPlus className="h-4 w-4" />
                {invite.isPending
                  ? "Sending…"
                  : `Send ${fields.length > 1 ? `${fields.length} invites` : "invite"}`}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}
