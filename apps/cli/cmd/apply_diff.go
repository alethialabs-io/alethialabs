// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/packages/core/designfile"

// The field diff lives in `packages/core/designfile` (fields.go), so the CLI's plan and the
// runner's design-file job compare a file with the server by one rule. These are the names the
// commands already use for it — the same types and the same function values, never a copy.

// FieldChange is one field the file declares whose value differs from the server's.
type FieldChange = designfile.FieldChange

var (
	// diffFields compares the fields a file declares with the values the server holds.
	diffFields = designfile.DiffFields
	// stringKeyed reads a decoded mapping as a map[string]any, and reports whether it was one.
	stringKeyed = designfile.StringKeyed
	// sortChanges orders changes by field, then key.
	sortChanges = designfile.SortChanges
	// valuesEqual reports whether two decoded values mean the same thing.
	valuesEqual = designfile.ValuesEqual
	// formatFieldValue renders one side of a change for a person.
	formatFieldValue = designfile.FormatFieldValue
	// changedFields is the request body of an update: the file's value for each changed field.
	changedFields = designfile.ChangedFields
)
