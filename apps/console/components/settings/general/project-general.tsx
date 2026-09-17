"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project · Settings · General — the project-native counterpart of OrgGeneral. Rename the project
// (the slug stays stable so URLs don't break) and a danger-zone delete. Composed from the shared
// settings primitives. Wired to projects.ts (updateProjectName / deleteProject). Delete refuses
// server-side while any environment is live — destroy those first.

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  deleteProject,
  updateProjectName,
} from "@/app/server/actions/projects";
import { canSlugify } from "@/lib/utils/slugify";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/validations/project-form.schema";
import { ClassificationControl } from "@/components/classification/classification-control";
import {
  SettingsCardFoot,
  SettingsDangerRow,
  SettingsField,
  SettingsInput,
  SettingsPanel,
  SettingsSection,
  settingsControl,
  settingsControlSize,
} from "@/components/settings/settings-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

// The bound is READ from the schema, not retyped: this file carried a literal `100` while
// `project-form.schema.ts` owned `PROJECT_NAME_MAX_LENGTH`, which is how create and rename came to
// disagree at 50 vs 100 once already. `canSlugify` is here for the same reason — the create path
// applies it and, since #4644, so does `updateProjectName`, so a name this form accepts and the
// server refuses would be a new instance of the asymmetry rather than a leftover of the old one.
const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "A project name is required")
    .max(
      PROJECT_NAME_MAX_LENGTH,
      `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`,
    )
    .refine((v) => canSlugify(v), "Enter at least one letter or number"),
});
type NameForm = z.infer<typeof nameSchema>;

/** The project General settings — rename + danger-zone delete. */
export function ProjectGeneral({
  projectId,
  orgSlug,
  initialName,
  slug,
}: {
  projectId: string;
  orgSlug: string;
  initialName: string;
  slug: string | null;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [name, setName] = useState(initialName);
  const form = useForm<NameForm>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: initialName },
  });

  /**
   * Persist the rename; keep the form's baseline in sync so the Save button re-disables.
   *
   * A refusal now arrives as `{ ok: false, error }` and is attached to the FIELD, not only to a
   * toast: a toast is gone in four seconds and the name that caused it is still in the box. Before
   * #4644 the action threw, and a production build redacted the message — so "that name is taken"
   * rendered as a digest, which is indistinguishable from the rename being broken.
   *
   * The `catch` stays for what is NOT a refusal: an unexpected failure is a defect, has no advice
   * in it, and keeps the generic sentence.
   */
  async function onSave(values: NameForm) {
    try {
      const res = await updateProjectName(projectId, values.name);
      if (!res.ok) {
        form.setError("name", { type: "server", message: res.error });
        toast.error(res.error);
        return;
      }
      setName(res.project_name);
      form.reset({ name: res.project_name });
      toast.success("Project updated.");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save changes.");
    }
  }

  /**
   * Delete the project record, then return to the org overview.
   *
   * The live-environment refusal is rendered IN the danger zone as well as toasted — the dialog
   * closes on click, so a toast alone leaves a user who looked away with a page that simply did
   * nothing. See `onSave` for why the `catch` still exists.
   */
  async function onDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await deleteProject(projectId);
      if (!res.ok) {
        setDeleteError(res.error);
        toast.error(res.error);
        setDeleting(false);
        return;
      }
      toast.success("Project deleted.");
      router.push(`/${orgSlug}`);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't delete the project.",
      );
      setDeleting(false);
    }
  }

  return (
    <div>
      <SettingsSection title="Project profile">
        <SettingsPanel>
          <form onSubmit={form.handleSubmit(onSave)}>
            <div className="py-1">
              <SettingsField
                label="Project name"
                hint="Shown across the console and the CLI."
              >
                <SettingsInput
                  className={cn(settingsControl, settingsControlSize)}
                  autoComplete="off"
                  {...form.register("name")}
                />
                {form.formState.errors.name && (
                  // Carries the SERVER's refusal as well as the client rule (see `onSave`), so
                  // `role="alert"` — a rename refused by the server changes nothing else on screen.
                  <span role="alert" className="text-ui-xs text-destructive">
                    {form.formState.errors.name.message}
                  </span>
                )}
              </SettingsField>
              <SettingsField
                label="Project URL"
                hint="The slug in this project's URLs — kept stable across renames."
              >
                <div className="flex h-[38px] items-center overflow-hidden rounded-sm border border-border-strong bg-surface-sunken px-3 font-mono text-ui-sm text-text-tertiary">
                  /{orgSlug}/{slug ?? "—"}
                </div>
              </SettingsField>
              {/* Classification (Workstream B) — chips + a picker for org editors. */}
              <SettingsField
                label="Classification"
                hint="Pin this project's classification values (e.g. Environment, Team)."
              >
                <ClassificationControl kind="project" id={projectId} canEdit />
              </SettingsField>
            </div>
            <SettingsCardFoot note="Applies across the console">
              <Button
                type="submit"
                size="sm"
                disabled={
                  form.formState.isSubmitting || !form.formState.isDirty
                }
              >
                {form.formState.isSubmitting ? "Saving…" : "Save changes"}
              </Button>
            </SettingsCardFoot>
          </form>
        </SettingsPanel>
      </SettingsSection>

      <SettingsSection title="Danger zone" className="mb-0">
        <SettingsPanel danger>
          <SettingsDangerRow
            title="Delete project"
            description={`Permanently delete ${name}, its environments, design, and history. This destroys no cloud resources — destroy the environments first. Cannot be undone.`}
          >
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  // See org-general.tsx — the trigger agrees with its own dialog (#4462).
                  <Button variant="outline" size="sm" aria-label="Delete project">
                    Delete
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the project and its environments,
                    design, and promotion history. Provisioned cloud resources
                    are not touched — destroy the environments first. This
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void onDelete()}
                    disabled={deleting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting ? "Deleting…" : "Delete project"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SettingsDangerRow>
          {/* The server's reason, kept on the page after the dialog closes. `role="alert"` so a
              screen reader is told too — the visual change is below the fold of the click. */}
          {deleteError && (
            <p role="alert" className="px-1 pb-1 text-ui-xs text-destructive">
              {deleteError}
            </p>
          )}
        </SettingsPanel>
      </SettingsSection>
    </div>
  );
}
