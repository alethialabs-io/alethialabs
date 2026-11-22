// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var classificationCmd = &cobra.Command{
	Use:     "classification",
	Aliases: []string{"class"},
	Short:   "Classify resources with the org's taxonomy",
	Long: `Classification is a governed taxonomy — named dimensions (axes) and their allowed
values — applied to resources. List the dimensions, view a resource's tags, and assign or
clear values. A resource is addressed by its kind and id (e.g. project_environment <uuid>).

The dimension key and the value slug are OPTIONAL: omit them on a terminal and you are asked,
from the org's own taxonomy rather than from a key you copied out of "dimensions".`,
}

var classificationDimensionsCmd = &cobra.Command{
	Use:   "dimensions",
	Short: "List the org's classification dimensions and values",
	Long: `List the active organization's classification dimensions: each axis, whether a
resource may carry one value of it or several, the resource kinds it applies to, and the
value slugs it allows. These are the keys and slugs "classification assign" takes.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := runListCommand(cmd, dimensionListView, client.ListClassificationDimensions); err != nil {
			fail(err)
		}
	},
}

// dimensionListView is how `classification dimensions` is drawn.
var dimensionListView = listView[api.ClassificationDimension]{
	Spinner: "Fetching dimensions...",
	Title:   "dimensions",
	Empty:   "No classification dimensions defined. An admin defines them in the console.",
	Columns: dimensionColumns,
	Rows:    dimensionRows,
}

var dimensionColumns = []string{"Key", "Label", "Mode", "Applies to", "Values"}

// dimensionRows projects the taxonomy into plain table rows.
func dimensionRows(dims []api.ClassificationDimension, outFmt string) [][]string {
	rows := make([][]string, len(dims))
	for i, d := range dims {
		mode := "single"
		if d.Multi {
			mode = "multi"
		}
		applies := "all resources"
		if len(d.AppliesTo) > 0 {
			applies = strings.Join(d.AppliesTo, ", ")
		}
		// Show the value slugs, not just a count — `classification assign` takes a
		// value-slug, so the slugs must be discoverable from this list.
		values := strings.Join(dimensionSlugs(d), ", ")
		rows[i] = []string{d.Key, d.Label, mode, applies, ui.Cell(outFmt, values, ui.OrDash(values))}
	}
	return rows
}

// runClassificationDimensions fetches and renders the taxonomy (non-interactive path).
func runClassificationDimensions(c apiClient, out io.Writer, format string) error {
	dims, err := c.ListClassificationDimensions()
	if err != nil {
		return governanceError(err)
	}
	return renderList(out, format, dimensionListView, dims)
}

var classificationShowCmd = &cobra.Command{
	Use:   "show [kind] [id]",
	Short: "Show the classification values assigned to a resource",
	Long: `Read the classification values a resource carries. The kind and the id are OPTIONAL:
omit them on a terminal and you are asked, with the kinds offered from the org's own taxonomy
rather than from a string you copied out of "dimensions".`,
	Args: cobra.RangeArgs(0, 2),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runClassificationShowCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runClassificationShowCmd is `classification show`: it resolves the resource and prints the
// values it carries.
func runClassificationShowCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	kind, id, err := resolveClassificationTarget(client, args)
	if err != nil {
		return err
	}
	return runListCommand(cmd, assignmentListView, func() ([]api.ClassificationAssignment, error) {
		return client.GetResourceClassifications(kind, id)
	})
}

// assignmentListView is how `classification show` is drawn.
var assignmentListView = listView[api.ClassificationAssignment]{
	Spinner: "Fetching classifications...",
	Title:   "classifications",
	Empty:   "Not classified. Label it with `alethia classification assign`.",
	Columns: assignmentColumns,
	Rows: func(rows []api.ClassificationAssignment, _ string) [][]string {
		return assignmentRows(rows)
	},
}

// resolveClassificationTarget answers "which resource?" for `show`.
//
// Both values are REQUIRED — neither has a default and neither can be guessed — so this is the
// requireInteractiveForm arm rather than the canPromptForm one: a scripted caller that names
// neither is refused, and the refusal names the two tokens to pass rather than saying "interactive
// input required" and stopping there.
//
// The kind comes from the taxonomy's own `applies_to`, which is the same source
// `assign` picks a dimension from. That is the point of asking at all: `show` used to take a kind
// that had to be read out of the `dimensions` table (or out of the docs example) and typed back in,
// which is exactly the copied token this programme exists to remove.
func resolveClassificationTarget(c apiClient, args []string) (kind, id string, err error) {
	if len(args) > 0 {
		kind = strings.TrimSpace(args[0])
	}
	if len(args) > 1 {
		id = strings.TrimSpace(args[1])
	}
	if kind != "" && id != "" {
		return kind, id, nil
	}

	kindField := mustGovField("alethia classification show", fieldKeyClassKind)
	idField := mustGovField("alethia classification show", fieldKeyClassID)
	if ferr := requireInteractiveForm(); ferr != nil {
		var missing []string
		if kind == "" {
			missing = append(missing, strings.ToLower(kindField.Title))
		}
		if id == "" {
			missing = append(missing, strings.ToLower(idField.Title))
		}
		e := refusal(clierr.CodeInputRequired, "alethia classification dimensions",
			"no %s given: `alethia classification show %s %s` takes both, and "+
				"`alethia classification dimensions` names the kinds the taxonomy targets (%v)",
			strings.Join(missing, " and "), kindField.Arg, idField.Arg, ferr)
		e.Cause = ferr
		return "", "", e
	}

	if kind == "" {
		if kind, err = pickClassificationKind(c, kindField); err != nil {
			return "", "", err
		}
	}
	if id == "" {
		if err := runHuhForm(huh.NewGroup(
			huh.NewInput().
				Title(idField.Title).
				Description(idField.Description).
				Value(&id).
				Validate(requireNonEmpty(strings.ToLower(idField.Title))),
		)); err != nil {
			return "", "", err
		}
		id = strings.TrimSpace(id)
	}
	return kind, id, nil
}

// pickClassificationKind asks which record type to read labels off.
//
// The offer is the union of every dimension's `applies_to`, and it is an OFFER and not a validation
// set — the same bound dimensionsFor records. A taxonomy whose dimensions all target every kind
// names no kinds at all, and that is a real answer rather than an empty picker: the question falls
// back to a typed line, which is what the positional carried before.
func pickClassificationKind(c apiClient, f govField) (string, error) {
	dims, err := c.ListClassificationDimensions()
	if err != nil {
		return "", err
	}
	kinds := classificationKinds(dims)
	if len(kinds) == 0 {
		kind := ""
		if err := runHuhForm(huh.NewGroup(
			huh.NewInput().
				Title(f.Title).
				Description(f.Description).
				Value(&kind).
				Validate(requireNonEmpty(strings.ToLower(f.Title))),
		)); err != nil {
			return "", err
		}
		return strings.TrimSpace(kind), nil
	}
	options := make([]huh.Option[string], len(kinds))
	for i, k := range kinds {
		options[i] = huh.NewOption(k, k)
	}
	chosen := kinds[0]
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return chosen, nil
}

// classificationKinds returns the resource kinds the taxonomy targets, sorted and de-duplicated.
//
// A dimension with an EMPTY applies_to targets every kind and therefore names none — it contributes
// nothing to a list of kinds to choose from, which is why an all-empty taxonomy returns an empty
// slice rather than a list of one blank option.
func classificationKinds(dims []api.ClassificationDimension) []string {
	seen := map[string]bool{}
	var kinds []string
	for _, d := range dims {
		for _, k := range d.AppliesTo {
			k = strings.TrimSpace(k)
			if k == "" || seen[k] {
				continue
			}
			seen[k] = true
			kinds = append(kinds, k)
		}
	}
	sort.Strings(kinds)
	return kinds
}

var assignmentColumns = []string{"Dimension", "Value"}

// assignmentRows projects a resource's values into plain table rows.
func assignmentRows(rows []api.ClassificationAssignment) [][]string {
	out := make([][]string, len(rows))
	for i, a := range rows {
		out[i] = []string{a.DimensionLabel, a.ValueLabel}
	}
	return out
}

// runClassificationShow fetches and renders a resource's values (non-interactive path).
func runClassificationShow(c apiClient, out io.Writer, format, kind, id string) error {
	rows, err := c.GetResourceClassifications(kind, id)
	if err != nil {
		return governanceError(err)
	}
	return renderList(out, format, assignmentListView, rows)
}

var classificationAssignCmd = &cobra.Command{
	Use:   "assign <kind> <id> [dimension-key] [value-slug]",
	Short: "Assign a classification value to a resource",
	Long: `Pin one of the org's classification values to a resource. The dimension key and the
value slug are optional: omit them on a terminal and you are asked, from the taxonomy itself.

Scripted, pass all four — the values are the ones "alethia classification dimensions" prints.
Assigning a value the resource already carries changes nothing, so the command is safe to
repeat. --dry-run checks the key and the slug against the taxonomy and assigns nothing.`,
	Args: cobra.RangeArgs(2, 4),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runClassificationAssignCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runClassificationAssignCmd is `classification assign`: it resolves the dimension and the value
// against the taxonomy and pins the value to the resource.
func runClassificationAssignCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	kind, id := args[0], args[1]
	dimensionKey, valueSlug, err := resolveClassification(client, kind, args[2:])
	if err != nil {
		return err
	}
	return runClassificationAssign(client, p,
		classificationChange{Kind: kind, ID: id, Dimension: dimensionKey, Value: valueSlug},
		cmdmeta.DryRunRequested(cmd))
}

// classificationChange is one value pinned to, or cleared from, one resource. It is the `object`
// of an assign or unassign result.
type classificationChange struct {
	Kind      string `json:"resource_kind"`
	ID        string `json:"resource_id"`
	Dimension string `json:"dimension_key,omitempty"`
	Value     string `json:"value"`
}

// result is the mutation result of the change: the resource is the subject.
func (c classificationChange) result(action ResultAction) MutationResult {
	return MutationResult{ID: c.ID, Kind: govKindClassification, Action: action, Object: c}
}

// dimensionSlugs returns a dimension's value slugs, in the order the taxonomy defines them.
func dimensionSlugs(d api.ClassificationDimension) []string {
	out := make([]string, len(d.Values))
	for i, v := range d.Values {
		out[i] = v.Value
	}
	return out
}

// dimensionsFor returns the dimensions that target a resource kind: those scoping to it
// explicitly, plus those with an empty applies_to, which target every kind.
//
// Used for the OFFER only. Nothing is refused on this basis: applies_to is the console's
// authoring hint, and the CLI cannot show that the server enforces it — so filtering the picker
// keeps the question short while an explicit `--` key outside the scope still reaches the server,
// which is the only side that knows.
func dimensionsFor(dims []api.ClassificationDimension, kind string) []api.ClassificationDimension {
	var out []api.ClassificationDimension
	for _, d := range dims {
		if len(d.AppliesTo) == 0 {
			out = append(out, d)
			continue
		}
		for _, k := range d.AppliesTo {
			if strings.EqualFold(k, kind) {
				out = append(out, d)
				break
			}
		}
	}
	return out
}

// resolveClassification answers "which dimension, and which of its values?" for `assign`.
//
// It fetches the taxonomy on EVERY path, including the fully-specified one, and that is the point.
// `assign` takes a four-token contract in which two tokens are slugs from a closed org-scoped set;
// a typo in either used to reach the server and come back as a 4xx naming neither the mistake nor
// the alternatives. The taxonomy is closed and org-scoped, and the assignment is made against the
// same org, so a key outside it is one the server would certainly refuse — which is the bound on
// what the CLI may reject, and it buys a refusal that lists the real keys.
func resolveClassification(c apiClient, kind string, rest []string) (dimensionKey, valueSlug string, err error) {
	dims, err := c.ListClassificationDimensions()
	if err != nil {
		return "", "", err
	}
	if len(dims) == 0 {
		return "", "", refusal(clierr.CodeConflict, "alethia classification dimensions",
			"this organization has no classification dimensions — an admin defines them in the console before anything can be labelled")
	}

	if len(rest) > 0 && strings.TrimSpace(rest[0]) != "" {
		dimensionKey = strings.TrimSpace(rest[0])
	} else {
		dimensionKey, err = pickDimension(dimensionsFor(dims, kind), kind)
		if err != nil {
			return "", "", err
		}
	}

	chosen, err := findDimension(dims, dimensionKey)
	if err != nil {
		return "", "", err
	}

	if len(rest) > 1 && strings.TrimSpace(rest[1]) != "" {
		valueSlug = strings.TrimSpace(rest[1])
		if !containsFold(dimensionSlugs(chosen), valueSlug) {
			return "", "", refusal(clierr.CodeValidationFailed, "alethia classification dimensions",
				"%q is not a value of the %q dimension (want one of: %s)",
				valueSlug, chosen.Key, strings.Join(dimensionSlugs(chosen), ", "))
		}
		return chosen.Key, valueSlug, nil
	}
	valueSlug, err = pickDimensionValue(chosen)
	return chosen.Key, valueSlug, err
}

// findDimension resolves a dimension key against the taxonomy, naming the real keys on a miss.
func findDimension(dims []api.ClassificationDimension, key string) (api.ClassificationDimension, error) {
	keys := make([]string, len(dims))
	for i, d := range dims {
		if strings.EqualFold(d.Key, key) {
			return d, nil
		}
		keys[i] = d.Key
	}
	return api.ClassificationDimension{}, refusal(clierr.CodeNotFound, "alethia classification dimensions",
		"no classification dimension %q in this organization (want one of: %s)",
		key, strings.Join(keys, ", "))
}

// pickDimension asks which axis to set.
func pickDimension(dims []api.ClassificationDimension, kind string) (string, error) {
	if len(dims) == 0 {
		return "", refusal(clierr.CodeNotFound, "alethia classification dimensions",
			"no classification dimension targets %s — run `alethia classification dimensions` to see what each one applies to", kind)
	}
	if err := requireInteractiveForm(); err != nil {
		return "", inputRequiredError(err, "no dimension key given: pass one as the argument (see `alethia classification dimensions`)")
	}
	f := mustGovField("alethia classification assign", fieldKeyClassDimension)
	options := make([]huh.Option[int], len(dims))
	for i, d := range dims {
		mode := "single"
		if d.Multi {
			mode = "multi"
		}
		options[i] = huh.NewOption(govBullet(d.Label, d.Key, mode), i)
	}
	chosen := 0
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return dims[chosen].Key, nil
}

// pickDimensionValue asks which of a dimension's allowed values to pin.
func pickDimensionValue(d api.ClassificationDimension) (string, error) {
	if len(d.Values) == 0 {
		return "", refusal(clierr.CodeConflict, "alethia classification dimensions",
			"the %q dimension has no allowed values to assign", d.Key)
	}
	if err := requireInteractiveForm(); err != nil {
		return "", inputRequiredError(err, "no value slug given: pass one of %s as the argument",
			strings.Join(dimensionSlugs(d), ", "))
	}
	f := mustGovField("alethia classification assign", fieldKeyClassValue)
	options := make([]huh.Option[int], len(d.Values))
	for i, v := range d.Values {
		options[i] = huh.NewOption(govBullet(v.Label, v.Value), i)
	}
	chosen := 0
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return d.Values[chosen].Value, nil
}

// runClassificationAssign pins one value to one resource and confirms it.
func runClassificationAssign(c apiClient, p *Printer, change classificationChange, dryRun bool) error {
	said := fmt.Sprintf("%s=%s to %s %s", change.Dimension, change.Value, change.Kind, change.ID)
	if dryRun {
		return printDryRun(p, change.result(ResultUpdated), "Would assign "+said)
	}
	if _, err := c.AssignClassification(change.Kind, change.ID, change.Dimension, change.Value); err != nil {
		return err
	}
	return printChange(p, change.result(ResultUpdated), "Assigned "+said)
}

var classificationUnassignYes bool

var classificationUnassignCmd = &cobra.Command{
	Use:   "unassign <kind> <id> [value-slug]",
	Short: "Clear a classification value from a resource",
	Long: `Clear one classification value from a resource. Policy that selects on the value
stops matching the resource. Assign the value again to restore it.

The value slug is optional: omit it on a terminal and you are asked, from the values the
resource ACTUALLY carries. The command asks before it clears; with nobody to ask, pass the
slug with --yes. --dry-run names the value that would be cleared and clears nothing.`,
	Args: cobra.RangeArgs(2, 3),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runClassificationUnassignCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runClassificationUnassignCmd is `classification unassign`: it resolves the value, confirms,
// and clears it.
func runClassificationUnassignCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	kind, id := args[0], args[1]
	valueSlug, err := resolveAssignedValue(client, kind, id, args[2:])
	if err != nil {
		return err
	}
	change := classificationChange{Kind: kind, ID: id, Value: valueSlug}
	if cmdmeta.DryRunRequested(cmd) {
		return printDryRun(p, change.result(ResultDeleted),
			fmt.Sprintf("Would clear %s from %s %s", valueSlug, kind, id))
	}
	ok, err := confirmChange(classificationUnassignYes,
		replayLine("alethia", "classification", "unassign", kind, id, valueSlug),
		fmt.Sprintf("Clear %s from %s %s?", valueSlug, kind, id),
		"Policy that selects on this classification stops matching the resource.")
	if err != nil || !ok {
		return err
	}
	return runClassificationUnassign(client, p, change)
}

// resolveAssignedValue answers "which value?" for `unassign`.
//
// The candidates are what the RESOURCE carries, not the org's whole taxonomy — deliberately a
// different source from `assign`'s. The two questions look alike and are not: assign chooses from
// everything that could be true of the resource, unassign from what currently IS. Offering the
// taxonomy here would let someone clear a value the resource never had, which the server answers
// with a no-op the CLI would report as a success.
func resolveAssignedValue(c apiClient, kind, id string, rest []string) (string, error) {
	if len(rest) > 0 && strings.TrimSpace(rest[0]) != "" {
		return strings.TrimSpace(rest[0]), nil
	}
	assigned, err := c.GetResourceClassifications(kind, id)
	if err != nil {
		return "", err
	}
	if len(assigned) == 0 {
		return "", refusal(clierr.CodeNotFound, replayLine("alethia", "classification", "show", kind, id),
			"%s %s carries no classification values to clear", kind, id)
	}
	if err := requireInteractiveForm(); err != nil {
		return "", inputRequiredError(err, "no value slug given: pass one of %s as the argument",
			strings.Join(assignedSlugs(assigned), ", "))
	}
	f := mustGovField("alethia classification unassign", fieldKeyClassValue)
	options := make([]huh.Option[int], len(assigned))
	for i, a := range assigned {
		options[i] = huh.NewOption(govBullet(a.DimensionLabel, a.ValueLabel, a.Value), i)
	}
	chosen := 0
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return assigned[chosen].Value, nil
}

// assignedSlugs returns the value slugs a resource carries, for the refusal message.
func assignedSlugs(assigned []api.ClassificationAssignment) []string {
	out := make([]string, len(assigned))
	for i, a := range assigned {
		out[i] = a.Value
	}
	return out
}

// runClassificationUnassign clears one value from one resource and confirms it.
func runClassificationUnassign(c apiClient, p *Printer, change classificationChange) error {
	if err := c.UnassignClassification(change.Kind, change.ID, change.Value); err != nil {
		return err
	}
	return printChange(p, change.result(ResultDeleted),
		fmt.Sprintf("Cleared %s from %s %s", change.Value, change.Kind, change.ID))
}

func init() {
	classificationCmd.AddCommand(classificationDimensionsCmd)
	classificationCmd.AddCommand(classificationShowCmd)
	classificationCmd.AddCommand(classificationAssignCmd)
	addYesFlag(classificationUnassignCmd, &classificationUnassignYes)
	classificationCmd.AddCommand(classificationUnassignCmd)
	rootCmd.AddCommand(classificationCmd)
}
