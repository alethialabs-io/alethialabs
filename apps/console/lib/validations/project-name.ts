// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project RENAME's name rule (#6128): read by the project General form's resolver and by the
// `renameProject` action's input, so the two cannot disagree.
//
// The bound is READ from the project form schema, not retyped: the rename form once carried a
// literal `100` while `project-form.schema.ts` owned `PROJECT_NAME_MAX_LENGTH`, which is how create
// and rename came to disagree at 50 vs 100. `canSlugify` is here for the same reason — the create
// path applies it and, since #4644, so does `updateProjectName`.

import { z } from "zod";
import { canSlugify } from "@/lib/utils/slugify";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/validations/project-form.schema";

/** A project's display name, as the rename accepts it. */
export const projectNameSchema = z
	.string()
	.trim()
	.min(1, "A project name is required")
	.max(PROJECT_NAME_MAX_LENGTH, `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`)
	.refine((v) => canSlugify(v), "Enter at least one letter or number");
