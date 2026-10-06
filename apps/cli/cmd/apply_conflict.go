// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// The two refusals a component update can meet on the server (#5551), and what apply says about them.
//
// An update is computed against the copy `plan` read and is sent with that copy's revision as
// If-Match. The server refuses it when the component has changed since — a console edit, another
// apply — and returns its copy now; the reader then names the fields that differ between the two
// copies, because "it changed" alone sends the person hunting. It also refuses any update while a
// deploy or destroy of the component's environment is queued or running. Neither refusal is retried: the plan the person
// confirmed no longer describes the server, so the next step is theirs.

// rerunPlanHint is the next step after the server's copy moved under the plan.
const rerunPlanHint = "re-run `alethia plan` to see the difference against the server's copy now, then apply again"

// componentUpdateRefusal is the sentence a refused update is reported with. A conflict is explained
// from the plan's copy and the server's; any other error is reported as the server put it.
func componentUpdateRefusal(comp ComponentPlan, err error) string {
	var conflict *api.ComponentConflictError
	if !errors.As(err, &conflict) {
		return err.Error()
	}
	label := componentLabel(comp)
	if conflict.Busy() {
		if conflict.Run == nil {
			return fmt.Sprintf("%s was not changed — a deploy or destroy of this environment was running when apply sent the change, and has finished since; re-run `alethia apply`", label)
		}
		verb := "deploy"
		if conflict.Run.Type == "DESTROY" {
			verb = "destroy"
		}
		return fmt.Sprintf("%s cannot be changed while a %s of this environment is %s (job %s); follow it with `alethia jobs logs %s`, then re-run `alethia apply` once it has finished",
			label, verb, strings.ToLower(conflict.Run.Status), conflict.Run.ID, conflict.Run.ID)
	}
	if conflict.Current == nil {
		return fmt.Sprintf("%s no longer exists on the server — it was removed after `alethia plan` read it; %s", label, rerunPlanHint)
	}
	changed := serverSideChanges(comp.read, componentValues(*conflict.Current))
	if len(changed) == 0 {
		return fmt.Sprintf("%s was saved on the server after `alethia plan` read it (none of its settings differ — it was re-saved or redeployed); %s",
			label, rerunPlanHint)
	}
	return fmt.Sprintf("%s changed on the server after `alethia plan` read it: %s; %s",
		label, strings.Join(changed, ", "), rerunPlanHint)
}

// serverSideChanges names each setting whose value differs between the copy the plan read and the
// server's copy now, as `field: before → after`, sorted by field. Every setting is compared, not only
// the ones the file declares: a concurrent change to a field the file does not mention is still a
// change the person's plan did not see.
func serverSideChanges(read, now map[string]any) []string {
	fields := map[string]bool{}
	for f := range read {
		fields[f] = true
	}
	for f := range now {
		fields[f] = true
	}
	names := make([]string, 0, len(fields))
	for f := range fields {
		names = append(names, f)
	}
	sort.Strings(names)
	var out []string
	for _, f := range names {
		if valuesEqual(read[f], now[f]) {
			continue
		}
		out = append(out, fmt.Sprintf("%s: %s → %s", f, formatFieldValue(read[f]), formatFieldValue(now[f])))
	}
	return out
}
