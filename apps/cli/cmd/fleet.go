// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

var fleetCmd = &cobra.Command{
	Use:   "fleet",
	Short: "Inspect and configure managed-fleet warm pools",
	Long: `The managed fleet is the platform's pool of warm provisioning runners (one pool
per cloud). List the configured pools and update a pool's capacity, locations, version, or
enabled state. Fleet config is platform-operator infrastructure — only available on
self-managed deployments, to organization owners/admins.`,
}

var fleetListCmd = &cobra.Command{
	Use:   "list",
	Short: "List managed-fleet warm pools",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var pools []api.FleetPool
			ui.RunSpinner("Fetching fleet pools...", func() { pools, err = client.ListFleetPools() })
			if err != nil {
				failf("Failed to list fleet pools: %v", err)
			}
			if len(pools) == 0 {
				ui.Muted("No fleet pools configured.")
				return
			}
			_ = ui.ShowTable(fleetListColumns, fleetRows(pools), "fleet pools")
			return
		}
		if err := runFleetList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list fleet pools: %v", err)
		}
	},
}

var fleetListColumns = []string{"Provider", "Enabled", "Warm", "Max", "Slots", "Locations", "Version"}

// fleetRows projects pools into plain table rows. The version cell prefers a pinned
// version, falls back to the channel, else a dash.
func fleetRows(pools []api.FleetPool) [][]string {
	rows := make([][]string, len(pools))
	for i, p := range pools {
		rows[i] = []string{
			p.Provider,
			yesNo(p.Enabled),
			strconv.Itoa(p.WarmMin),
			strconv.Itoa(p.Max),
			strconv.Itoa(p.SlotsPerRunner),
			orDash(strings.Join(p.Locations, ",")),
			fleetVersionCell(p),
		}
	}
	return rows
}

// fleetVersionCell renders a pool's version target: a pinned version, else the channel,
// else a dash.
func fleetVersionCell(p api.FleetPool) string {
	if p.Version != "" {
		return p.Version
	}
	if p.Channel != "" {
		return p.Channel + " (channel)"
	}
	return ui.SymbolDash
}

// runFleetList fetches and renders the fleet pools (non-interactive path).
func runFleetList(c apiClient, out io.Writer, format string) error {
	pools, err := c.ListFleetPools()
	if err != nil {
		return err
	}
	if len(pools) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No fleet pools configured."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: fleetListColumns,
		Rows:    fleetRows(pools),
	}, pools)
}

var (
	fleetWarmMin int
	fleetMax     int
	fleetSlots   int
	fleetEnabled bool
	fleetChannel string
	fleetVersion string
)

var fleetSetCmd = &cobra.Command{
	Use:   "set <provider>",
	Short: "Update a managed-fleet warm pool",
	Long: `Update the warm pool for a provider (aws, gcp, azure). Only the flags you pass
are changed; the rest keep their stored value. A pinned --version and a release --channel
are mutually exclusive (a version pin clears the channel).`,
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		update, changed := buildFleetUpdate(cmd)
		if !changed {
			failf("Nothing to update — pass at least one of --warm-min, --max, --slots, --enabled, --channel, --version")
		}
		// Disabling a pool drains its runners (a capacity reduction) — confirm first.
		if update.Enabled != nil && !*update.Enabled {
			if !confirm("Disable this pool?", "The controller stops provisioning for it and drains its runners.") {
				return
			}
		}
		if err := runFleetSet(api.NewClient(token), os.Stdout, args[0], update); err != nil {
			failf("Failed to update fleet pool: %v", err)
		}
	},
}

// buildFleetUpdate assembles a partial pool update from the flags the caller actually set,
// so unspecified config keeps its stored value. The bool return reports whether any field
// was provided.
func buildFleetUpdate(cmd *cobra.Command) (api.FleetPoolUpdate, bool) {
	var update api.FleetPoolUpdate
	changed := false
	if cmd.Flags().Changed("warm-min") {
		v := fleetWarmMin
		update.WarmMin, changed = &v, true
	}
	if cmd.Flags().Changed("max") {
		v := fleetMax
		update.Max, changed = &v, true
	}
	if cmd.Flags().Changed("slots") {
		v := fleetSlots
		update.SlotsPerRunner, changed = &v, true
	}
	if cmd.Flags().Changed("enabled") {
		v := fleetEnabled
		update.Enabled, changed = &v, true
	}
	if cmd.Flags().Changed("channel") {
		v := fleetChannel
		update.Channel, changed = &v, true
	}
	if cmd.Flags().Changed("version") {
		v := fleetVersion
		update.Version, changed = &v, true
	}
	return update, changed
}

// runFleetSet applies the update to the provider's pool and confirms it.
func runFleetSet(c apiClient, out io.Writer, provider string, update api.FleetPoolUpdate) error {
	pool, err := c.SetFleetPool(provider, update)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf(
		"Updated %s pool (warm %d, max %d, %s)",
		pool.Provider, pool.WarmMin, pool.Max, enabledLabel(pool.Enabled),
	)))
	return nil
}

// enabledLabel renders a pool's enabled state as a word for the confirmation line.
func enabledLabel(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "paused"
}

func init() {
	fleetSetCmd.Flags().IntVar(&fleetWarmMin, "warm-min", 0, "Always-warm floor of runners")
	fleetSetCmd.Flags().IntVar(&fleetMax, "max", 0, "Hard ceiling on instances")
	fleetSetCmd.Flags().IntVar(&fleetSlots, "slots", 0, "Concurrent jobs per runner")
	fleetSetCmd.Flags().BoolVar(&fleetEnabled, "enabled", false, "Enable (true) or pause (false) the pool")
	fleetSetCmd.Flags().StringVar(&fleetChannel, "channel", "", "Release channel to track (e.g. stable)")
	fleetSetCmd.Flags().StringVar(&fleetVersion, "version", "", "Pin an exact runner version (clears the channel)")

	fleetCmd.AddCommand(fleetListCmd)
	fleetCmd.AddCommand(fleetSetCmd)
	rootCmd.AddCommand(fleetCmd)
}
