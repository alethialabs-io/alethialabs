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

var componentListKind string

// currentComponentEnv reads the component group's persistent --env. Persistent so `list`, `add` and
// `remove` name an environment the same way; before this, `--env` existed on `list` alone and was
// documented "(reserved)" while the server dropped it, and the write paths had no way to say which
// environment they meant at all.
//
// Empty is meaningful and differs per verb, which the server decides: a write with no --env targets
// the project's DEFAULT environment (so existing single-environment scripts keep working), while a
// list with no --env shows EVERY environment rather than silently narrowing to one.
func currentComponentEnv(cmd *cobra.Command) string {
	env, err := cmd.Flags().GetString("env")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(env)
}

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
				comps, err = client.ListComponents(project, componentListKind, currentComponentEnv(cmd))
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
		if err := runComponentList(client, os.Stdout, outputFormat(cmd), project, componentListKind, currentComponentEnv(cmd)); err != nil {
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
		if err := runComponentAdd(api.NewClient(token), os.Stdout, project, componentAddKind, componentAddName, currentComponentEnv(cmd), fields); err != nil {
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

// runComponentAdd creates the component and confirms it. An empty env means the project's default
// environment, resolved server-side.
func runComponentAdd(c apiClient, out io.Writer, project, kind, name, env string, fields map[string]interface{}) error {
	if kind == "" {
		return fmt.Errorf("--kind is required (see `alethia project component kinds`)")
	}
	comp, err := c.AddComponent(project, kind, name, env, fields)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Added %s component %s (%s)%s", comp.Kind, comp.Name, comp.ID, envSuffix(env))))
	return nil
}

// envSuffix renders " in <env>" for a confirmation line, or nothing when no environment was named.
// The environment belongs in the confirmation because it is the thing a caller most needs to see they
// got right: authoring the same kind into the wrong tier is silent, and the next thing that reads it
// is a deploy.
func envSuffix(env string) string {
	if env == "" {
		return ""
	}
	return " in " + env
}

// --- remove ---

var (
	componentRemoveKind string
	componentRemoveName string
)

// componentRemoveYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var componentRemoveYes bool

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
		if !confirmDestructive(componentRemoveYes, "Remove this component?", "Its configuration is deleted (provisioned resources are removed on the next apply/destroy).") {
			return
		}
		if err := runComponentRemove(api.NewClient(token), os.Stdout, project, componentRemoveKind, componentRemoveName, currentComponentEnv(cmd)); err != nil {
			failf("Failed to remove component: %v", err)
		}
	},
}

// runComponentRemove deletes the component and confirms it. Singleton kinds ignore the name. An empty
// env means the project's default environment; the delete is scoped to that ONE environment either
// way, so a sibling tier's row is never collateral.
func runComponentRemove(c apiClient, out io.Writer, project, kind, name, env string) error {
	if singletonKinds[kind] {
		name = ""
	}
	if err := c.RemoveComponent(project, kind, name, env); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Component removed"+envSuffix(env)))
	return nil
}

func init() {
	addYesFlag(projectComponentRemoveCmd, &componentRemoveYes)
	projectComponentCmd.PersistentFlags().String("project", "", "Project name or id")
	// PERSISTENT, so add/remove can name an environment too. It used to exist on `list` alone,
	// labelled "(reserved)", and the server discarded it — so the CLI could only ever author into
	// the default environment, which made a two-tier project (dev and staging pointing at different
	// overlays) impossible to build from the terminal.
	projectComponentCmd.PersistentFlags().String("env", "", "Environment id, name or stage — writes default to the project's default environment, `list` defaults to all")

	projectComponentListCmd.Flags().StringVar(&componentListKind, "kind", "", "Filter by component kind")

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
