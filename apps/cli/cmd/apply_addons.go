// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
)

// The add-ons half of `plan` and `apply` (#5528), as it is PRINTED. The comparing is
// `packages/core/designfile`'s (plan_addons.go); what follows is the rule it applies, kept here
// because it is what the lines below show a person.
//
// An add-on in alethia.yaml is reconciled through the SAME request `alethia addon enable` sends, so
// it carries the same keep/clear rule: an omitted field keeps what is stored, `version: ""` removes
// the pin, each `settings` key merges over the stored ones (`key: null` resets it), and
// `values` / `values_file` replace the Advanced override whole (`values_file: ""` removes it).
//
// The plan compares only what the file declares. A setting is compared key by key against the
// stored settings the server returns with secrets removed; a reset (`key: null`) is compared against
// the catalog's default for that key, because that is what the server stores after a reset — so a
// reset settles after one apply instead of showing as a change forever.
//
// An add-on on the server that the file does not mention is UNMANAGED: listed, never disabled.

// addonSecretLabel stands in for a secret setting's value, which a plan never prints.
const addonSecretLabel = "(secret)"

// renderAddons prints one environment's add-ons: a line of `+ id`, `~ id`, `= id` cells, a line per
// changed field, and the unmanaged ones. A secret setting's value is never printed.
func renderAddons(out io.Writer, e EnvPlan, secretKeys func(id string) []string) {
	if len(e.Addons) == 0 && len(e.UnmanagedAddons) == 0 {
		return
	}
	if len(e.Addons) > 0 {
		cells := make([]string, len(e.Addons))
		for i, a := range e.Addons {
			cells[i] = glyphFor(a.Action) + " " + a.ID
		}
		fmt.Fprintf(out, "    add-ons  %s\n", strings.Join(cells, "  "))
	}
	for _, a := range e.Addons {
		secret := append(append([]string(nil), secretKeys(a.ID)...), a.SecretKeys...)
		for _, ch := range a.Changes {
			if ch.Field == "values" {
				// One side only: the summary already says what happens, and the stored side is
				// deliberately not described.
				fmt.Fprintf(out, "    %s %s  values: %s\n", glyphFor(ActionUpdate), a.ID, formatFieldValue(ch.To))
				continue
			}
			fmt.Fprintf(out, "    %s %s  %s: %s → %s\n", glyphFor(ActionUpdate), a.ID, ch.Label(),
				addonFieldValue(ch, ch.From, secret), addonFieldValue(ch, ch.To, secret))
		}
	}
	for _, id := range e.UnmanagedAddons {
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("    add-on %s is enabled on the server and not in the file — left alone (unmanaged)", id)))
	}
}

// addonFieldValue renders one side of an add-on change: a reset setting as `(default)`, a secret
// setting as `(secret)` whatever it holds, and anything else the way a component's field is.
func addonFieldValue(ch FieldChange, v any, secretKeys []string) string {
	if ch.Field == "settings" {
		for _, k := range secretKeys {
			if k == ch.Key {
				return addonSecretLabel
			}
		}
		if v == nil {
			return "(default)"
		}
	}
	return formatFieldValue(v)
}
