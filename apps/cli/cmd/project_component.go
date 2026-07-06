// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// componentKinds is the canonical list of authorable component kinds (mirrors the server
// registry in lib/cli/project-components.ts). singletonKinds are 1:1 per project (name-less);
// the rest are multi and keyed by name.
var componentKinds = []string{
	"network", "cluster", "dns", "observability", "repositories",
	"databases", "caches", "queues", "topics", "nosql_tables",
	"container_registries", "secrets", "storage_buckets",
}

var singletonKinds = map[string]bool{
	"network": true, "cluster": true, "dns": true,
	"observability": true, "repositories": true,
}

var projectComponentCmd = &cobra.Command{
	Use:     "component",
	Aliases: []string{"components", "comp"},
	Short:   "Manage a project's component resources",
	Long: `Components are the building blocks of a project's infrastructure: the network and
cluster, plus databases, caches, queues, topics, nosql tables, container registries, secrets,
storage buckets, DNS, and observability. One uniform group authors them all. The project is
named with --project (its name or id).`,
}

// --- kinds ---

var projectComponentKindsCmd = &cobra.Command{
	Use:   "kinds",
	Short: "List the supported component kinds",
	Run: func(cmd *cobra.Command, args []string) {
		if err := runComponentKinds(os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list kinds: %v", err)
		}
	},
}

var kindListColumns = []string{"Kind", "Cardinality"}

// kindRows projects the kind registry into plain table rows.
func kindRows() [][]string {
	rows := make([][]string, len(componentKinds))
	for i, k := range componentKinds {
		cardinality := "multi"
		if singletonKinds[k] {
			cardinality = "singleton"
		}
		rows[i] = []string{k, cardinality}
	}
	return rows
}

// runComponentKinds renders the supported component kinds.
func runComponentKinds(out io.Writer, format string) error {
	return ui.Render(out, format, ui.TableSpec{
		Columns: kindListColumns,
		Rows:    kindRows(),
	}, componentKinds)
}

// --- list ---

var (
	componentListKind string
	componentListEnv  string
)

var projectComponentListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's components",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var comps []api.Component
			ui.RunSpinner("Fetching components...", func() {
				comps, err = client.ListComponents(project, componentListKind, componentListEnv)
			})
			if err != nil {
				failf("Failed to list components: %v", err)
			}
			if len(comps) == 0 {
				ui.Muted("No components found.")
				return
			}
			_ = ui.ShowTable(componentListColumns, componentRows(comps), "components")
			return
		}
		if err := runComponentList(client, os.Stdout, outputFormat(cmd), project, componentListKind, componentListEnv); err != nil {
			failf("Failed to list components: %v", err)
		}
	},
}

var componentListColumns = []string{"Kind", "Name", "Status", "Identity"}

// componentRows projects components into plain table rows; an inherited (nil) identity
// renders as the dash glyph.
func componentRows(comps []api.Component) [][]string {
	rows := make([][]string, len(comps))
	for i, c := range comps {
		identity := ui.SymbolDash
		if c.CloudIdentityID != nil && *c.CloudIdentityID != "" {
			identity = *c.CloudIdentityID
		}
		status := c.Status
		if status == "" {
			status = ui.SymbolDash
		}
		rows[i] = []string{c.Kind, c.Name, status, identity}
	}
	return rows
}

// runComponentList fetches and renders a project's components (non-interactive path).
func runComponentList(c apiClient, out io.Writer, format, project, kind, env string) error {
	comps, err := c.ListComponents(project, kind, env)
	if err != nil {
		return err
	}
	if len(comps) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No components found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: componentListColumns,
		Rows:    componentRows(comps),
	}, comps)
}

// --- add ---

var (
	componentAddKind string
	componentAddName string
	componentAddSet  []string
)

var projectComponentAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add a component to a project",
	Long: `Add a component of --kind to a project. Set its fields with repeatable --set
key=value pairs (validated server-side against the component's schema). Singletons
(network, cluster, dns, observability, repositories) ignore --name; multi kinds require it.

Values are parsed as JSON when possible, else taken literally:
  --set port=5432            (number)
  --set iam_auth=true        (boolean)
  --set instance_types='["t3.medium"]'  (array)
  --set engine=postgres      (string)`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		fields, err := parseSetValues(componentAddSet)
		if err != nil {
			fail(err)
		}
		if err := runComponentAdd(api.NewClient(token), os.Stdout, project, componentAddKind, componentAddName, fields); err != nil {
			failf("Failed to add component: %v", err)
		}
	},
}

// parseSetValues parses repeatable `key=value` flags into a field map, coercing each value
// to its JSON type when it parses (number/bool/array/object/null), else keeping the literal.
func parseSetValues(sets []string) (map[string]interface{}, error) {
	out := map[string]interface{}{}
	for _, s := range sets {
		key, val, ok := strings.Cut(s, "=")
		if !ok || key == "" {
			return nil, fmt.Errorf("invalid --set %q (want key=value)", s)
		}
		out[key] = coerceSetValue(val)
	}
	return out, nil
}

// coerceSetValue returns the JSON-typed value of raw (number/bool/array/object/null) or the
// literal string when raw is not non-string JSON.
func coerceSetValue(raw string) interface{} {
	var v interface{}
	if err := json.Unmarshal([]byte(raw), &v); err == nil {
		switch v.(type) {
		case float64, bool, []interface{}, map[string]interface{}, nil:
			return v
		}
	}
	return raw
}

// runComponentAdd creates the component and confirms it.
func runComponentAdd(c apiClient, out io.Writer, project, kind, name string, fields map[string]interface{}) error {
	if kind == "" {
		return fmt.Errorf("--kind is required (see `alethia project component kinds`)")
	}
	comp, err := c.AddComponent(project, kind, name, fields)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Added %s component %s (%s)", comp.Kind, comp.Name, comp.ID)))
	return nil
}

// --- remove ---

var (
	componentRemoveKind string
	componentRemoveName string
)

var projectComponentRemoveCmd = &cobra.Command{
	Use:   "remove",
	Short: "Remove a component from a project",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		if componentRemoveKind == "" {
			failf("--kind is required (see `alethia project component kinds`)")
		}
		if !confirm("Remove this component?", "Its configuration is deleted (provisioned resources are removed on the next apply/destroy).") {
			return
		}
		if err := runComponentRemove(api.NewClient(token), os.Stdout, project, componentRemoveKind, componentRemoveName); err != nil {
			failf("Failed to remove component: %v", err)
		}
	},
}

// runComponentRemove deletes the component and confirms it. Singleton kinds ignore the name.
func runComponentRemove(c apiClient, out io.Writer, project, kind, name string) error {
	if singletonKinds[kind] {
		name = ""
	}
	if err := c.RemoveComponent(project, kind, name); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Component removed"))
	return nil
}

func init() {
	projectComponentCmd.PersistentFlags().String("project", "", "Project name or id")

	projectComponentListCmd.Flags().StringVar(&componentListKind, "kind", "", "Filter by component kind")
	projectComponentListCmd.Flags().StringVar(&componentListEnv, "env", "", "Filter by environment (reserved)")

	projectComponentAddCmd.Flags().StringVar(&componentAddKind, "kind", "", "Component kind (required)")
	projectComponentAddCmd.Flags().StringVar(&componentAddName, "name", "", "Component name (multi kinds)")
	projectComponentAddCmd.Flags().StringArrayVar(&componentAddSet, "set", nil, "Field assignment key=value (repeatable)")

	projectComponentRemoveCmd.Flags().StringVar(&componentRemoveKind, "kind", "", "Component kind (required)")
	projectComponentRemoveCmd.Flags().StringVar(&componentRemoveName, "name", "", "Component name (multi kinds)")

	projectComponentCmd.AddCommand(projectComponentKindsCmd)
	projectComponentCmd.AddCommand(projectComponentListCmd)
	projectComponentCmd.AddCommand(projectComponentAddCmd)
	projectComponentCmd.AddCommand(projectComponentRemoveCmd)
	projectCmd.AddCommand(projectComponentCmd)
}
