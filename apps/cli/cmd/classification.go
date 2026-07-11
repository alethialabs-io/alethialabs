// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var classificationCmd = &cobra.Command{
	Use:     "classification",
	Aliases: []string{"class"},
	Short:   "Classify resources with the org's taxonomy",
	Long: `Classification is a governed taxonomy — named dimensions (axes) and their allowed
values — applied to resources. List the dimensions, view a resource's tags, and assign or
clear values. A resource is addressed by its kind and id (e.g. project_environment <uuid>).`,
}

var classificationDimensionsCmd = &cobra.Command{
	Use:   "dimensions",
	Short: "List the org's classification dimensions and values",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var dims []api.ClassificationDimension
			ui.RunSpinner("Fetching dimensions...", func() {
				dims, err = client.ListClassificationDimensions()
			})
			if err != nil {
				failf("Failed to list dimensions: %v", err)
			}
			if len(dims) == 0 {
				ui.Muted("No classification dimensions defined.")
				return
			}
			_ = ui.ShowTable(dimensionColumns, dimensionRows(dims), "dimensions")
			return
		}
		if err := runClassificationDimensions(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list dimensions: %v", err)
		}
	},
}

var dimensionColumns = []string{"Key", "Label", "Mode", "Applies to", "Values"}

func dimensionRows(dims []api.ClassificationDimension) [][]string {
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
		rows[i] = []string{d.Key, d.Label, mode, applies, strconv.Itoa(len(d.Values))}
	}
	return rows
}

func runClassificationDimensions(c apiClient, out io.Writer, format string) error {
	dims, err := c.ListClassificationDimensions()
	if err != nil {
		return err
	}
	if len(dims) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No classification dimensions defined."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: dimensionColumns,
		Rows:    dimensionRows(dims),
	}, dims)
}

var classificationShowCmd = &cobra.Command{
	Use:   "show <kind> <id>",
	Short: "Show the classification values assigned to a resource",
	Args:  cobra.ExactArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var rows []api.ClassificationAssignment
			ui.RunSpinner("Fetching classifications...", func() {
				rows, err = client.GetResourceClassifications(args[0], args[1])
			})
			if err != nil {
				failf("Failed to fetch classifications: %v", err)
			}
			if len(rows) == 0 {
				ui.Muted("Not classified.")
				return
			}
			_ = ui.ShowTable(assignmentColumns, assignmentRows(rows), "classifications")
			return
		}
		if err := runClassificationShow(client, os.Stdout, outputFormat(cmd), args[0], args[1]); err != nil {
			failf("Failed to fetch classifications: %v", err)
		}
	},
}

var assignmentColumns = []string{"Dimension", "Value"}

func assignmentRows(rows []api.ClassificationAssignment) [][]string {
	out := make([][]string, len(rows))
	for i, a := range rows {
		out[i] = []string{a.DimensionLabel, a.ValueLabel}
	}
	return out
}

func runClassificationShow(c apiClient, out io.Writer, format, kind, id string) error {
	rows, err := c.GetResourceClassifications(kind, id)
	if err != nil {
		return err
	}
	if len(rows) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("Not classified."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: assignmentColumns,
		Rows:    assignmentRows(rows),
	}, rows)
}

var classificationAssignCmd = &cobra.Command{
	Use:   "assign <kind> <id> <dimension-key> <value-slug>",
	Short: "Assign a classification value to a resource",
	Args:  cobra.ExactArgs(4),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runClassificationAssign(api.NewClient(token), os.Stdout, args[0], args[1], args[2], args[3]); err != nil {
			failf("Failed to assign classification: %v", err)
		}
	},
}

func runClassificationAssign(c apiClient, out io.Writer, kind, id, dimensionKey, valueSlug string) error {
	if _, err := c.AssignClassification(kind, id, dimensionKey, valueSlug); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Assigned %s=%s to %s %s", dimensionKey, valueSlug, kind, id)))
	return nil
}

var classificationUnassignCmd = &cobra.Command{
	Use:   "unassign <kind> <id> <value-slug>",
	Short: "Clear a classification value from a resource",
	Args:  cobra.ExactArgs(3),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runClassificationUnassign(api.NewClient(token), os.Stdout, args[0], args[1], args[2]); err != nil {
			failf("Failed to unassign classification: %v", err)
		}
	},
}

func runClassificationUnassign(c apiClient, out io.Writer, kind, id, valueSlug string) error {
	if err := c.UnassignClassification(kind, id, valueSlug); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Cleared %s from %s %s", valueSlug, kind, id)))
	return nil
}

func init() {
	classificationCmd.AddCommand(classificationDimensionsCmd)
	classificationCmd.AddCommand(classificationShowCmd)
	classificationCmd.AddCommand(classificationAssignCmd)
	classificationCmd.AddCommand(classificationUnassignCmd)
	rootCmd.AddCommand(classificationCmd)
}
