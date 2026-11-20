// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var fleetCmd = &cobra.Command{
	Use:   "fleet",
	Short: "Inspect and size the managed fleet's warm pools",
	Long: `The managed fleet is the pool of runners the platform operates, one pool per cloud. A pool
keeps a number of runners warm and starts more as jobs queue, up to its maximum.

"alethia fleet list" shows the pools. "alethia fleet set" changes one pool's size, version or
enabled state.

This is the platform operator's surface. It answers only on a self-managed control plane, and
only to an organization owner or admin; on the hosted control plane Alethia operates the fleet
and these commands are refused.`,
}

var fleetListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the managed fleet's warm pools",
	Long: `Lists each cloud's warm pool: whether it is enabled, how many runners it keeps warm, its
maximum, the job slots per runner, its locations and the runner version it runs.

--output json prints the pool records as an array, and --output csv the wire values.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		p := printerFor(cmd)
		if interactiveTable(cmd) {
			var pools []api.FleetPool
			runSpinner("Fetching fleet pools...", func() { pools, err = client.ListFleetPools() })
			if err != nil {
				fail(fleetError(err))
			}
			if len(pools) == 0 {
				ui.MutedTo(p.Out, fleetEmptyState)
				return
			}
			_ = ui.ShowTable(fleetListColumns, fleetRows(pools, ui.FormatTable), "fleet pools")
			return
		}
		if err := runFleetList(client, p.Out, p.Format); err != nil {
			fail(fleetError(err))
		}
	},
}

// fleetEmptyState is what an empty pool list says, with the command that makes the first pool.
const fleetEmptyState = "No fleet pools configured. Create one with `alethia fleet set aws --warm-min 1 --max 3`."

// fleetError adds the next step to a fleet request the control plane refused. The fleet is the
// platform operator's, so "not found" and "forbidden" here mean this deployment or this caller
// has no fleet to manage, and the way to get jobs run is a runner of one's own.
func fleetError(err error) error {
	e := *clierr.From(err)
	if e.Hint != "" {
		return &e
	}
	if e.Class == clierr.ClassNotFound || e.Class == clierr.ClassForbidden {
		e.Hint = "alethia runner list   (the fleet is managed by the platform operator; your own runners are here)"
	}
	return &e
}

var fleetListColumns = []string{"Provider", "Enabled", "Warm", "Max", "Slots", "Locations", "Version"}

// fleetRows projects pools into plain table rows. The version cell prefers a pinned
// version, falls back to the channel, else a dash.
func fleetRows(pools []api.FleetPool, outFmt string) [][]string {
	rows := make([][]string, len(pools))
	for i, p := range pools {
		rows[i] = []string{
			p.Provider,
			ui.Cell(outFmt, ui.WireBool(p.Enabled), ui.YesNo(p.Enabled)),
			strconv.Itoa(p.WarmMin),
			strconv.Itoa(p.Max),
			strconv.Itoa(p.SlotsPerRunner),
			ui.Cell(outFmt, strings.Join(p.Locations, ","), ui.OrDash(strings.Join(p.Locations, ","))),
			fleetVersionCell(p, outFmt),
		}
	}
	return rows
}

// fleetVersionCell renders a pool's version target: a pinned version, else the channel,
// else a dash.
func fleetVersionCell(p api.FleetPool, outFmt string) string {
	if p.Version != "" {
		return p.Version
	}
	if p.Channel != "" {
		return ui.Cell(outFmt, p.Channel, p.Channel+" (channel)")
	}
	return ui.Cell(outFmt, "", ui.SymbolDash)
}

// runFleetList fetches and renders the fleet pools (non-interactive path).
func runFleetList(c apiClient, out io.Writer, format string) error {
	pools, err := c.ListFleetPools()
	if err != nil {
		return err
	}
	if len(pools) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(fleetEmptyState))
		return nil
	}
	if pools == nil {
		// An empty list is an empty array for a program, never null.
		pools = []api.FleetPool{}
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: fleetListColumns,
		Rows:    fleetRows(pools, format),
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

// fleetSetYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var fleetSetYes bool

var fleetSetCmd = &cobra.Command{
	Use:   "set [provider]",
	Short: "Create or resize one cloud's warm pool",
	Long: `Creates or updates the warm pool for one cloud. For an existing pool only the flags you pass
are changed; the rest keep their stored value. For a cloud with no pool yet this creates one:
the flags you pass are applied and every other setting takes its default (warm-min 1, max 10,
slots 1, enabled). A pinned --version and a release --channel are mutually exclusive (a version
pin clears the channel).

Omit the provider on a terminal and you are asked which cloud to configure.

--enabled=false pauses a pool: the controller stops provisioning for it and drains its runners.
That is confirmed first; with nobody to ask, pass --yes.

This is the platform operator's command. It answers only on a self-managed control plane, to an
organization owner or admin.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runFleetSetCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runFleetSetCmd is `fleet set`: it reads the update from the flags, resolves the cloud,
// confirms a pause, and sends the update or reports the one a dry run would send.
func runFleetSetCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	update, changed := buildFleetUpdate(cmd)
	if !changed {
		return refusal(clierr.CodeInvalidUsage, "alethia fleet set aws --max 3",
			"nothing to update: pass at least one of %s", strings.Join(fleetUpdateFlagNames(), ", "))
	}
	provider, err := resolveFleetProvider(args)
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	// Disabling a pool drains its runners (a capacity reduction) — confirm first. The
	// provider is named, because "this pool" is not something a reader can check against
	// what they meant, and with the picker the CLI may have chosen it.
	if update.Enabled != nil && !*update.Enabled {
		if !fleetSetYes && !canPromptForm() {
			return errConfirmRequiresYes
		}
		if !confirmDestructive(fleetSetYes, "Disable the "+provider+" pool?",
			"The controller stops provisioning for it and drains its runners.") {
			return nil
		}
	}
	result, err := runFleetSet(api.NewClient(token), provider, update)
	if err != nil {
		return fleetError(err)
	}
	return printFleetSet(p, result)
}

// fleetPoolKind is the `kind` of a fleet set result.
const fleetPoolKind = "fleet_pool"

// printFleetSet prints a fleet set result in p's format.
func printFleetSet(p *Printer, result MutationResult) error {
	return p.Result(result, func(w io.Writer) {
		if pool, ok := result.Object.(*api.FleetPool); ok {
			fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf(
				"Updated %s pool (warm %d, max %d, %s)",
				pool.Provider, pool.WarmMin, pool.Max, enabledLabel(pool.Enabled),
			)))
		}
	})
}

// resolveFleetProvider answers "which cloud?" from the positional argument or a picker.
//
// The picker offers every cloud_provider value, and NOTHING is validated against that set. The
// CLI does not know which clouds the fleet controller of the deployment it is talking to
// supports, so refusing on a list kept here could refuse a cloud that works.
//
// So the closed set is used for the OFFER, where being complete is the whole point, and the
// server keeps the refusal, which is the only place that knows.
func resolveFleetProvider(args []string) (string, error) {
	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		return strings.ToLower(strings.TrimSpace(args[0])), nil
	}
	if err := requireInteractiveForm(); err != nil {
		e := refusal(clierr.CodeInputRequired, "alethia fleet list",
			"no provider given: pass one of %s as the argument (%v)",
			strings.Join(cloudProviderNames(), ", "), err)
		e.Cause = err
		return "", e
	}
	f := mustGovField("alethia fleet set", fieldKeyFleetProvider)
	names := cloudProviderNames()
	options := make([]huh.Option[string], len(names))
	for i, name := range names {
		options[i] = huh.NewOption(name, name)
	}
	var chosen string
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return chosen, nil
}

// fleetUpdateFlagNames renders the update flags for the "nothing to update" refusal.
//
// FROM THE SPEC, not typed again. The hand-written list this replaced named six flags and would
// have gone on naming six after a seventh was added — and the reader of this message is exactly
// the person who cannot afford to be told about a subset of the flags that exist.
func fleetUpdateFlagNames() []string {
	var out []string
	for _, f := range govFields {
		if f.Command == "alethia fleet set" && f.Flag != "" {
			out = append(out, "--"+f.Flag)
		}
	}
	return out
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

// fleetSetClient is the one call `fleet set` makes.
type fleetSetClient interface {
	SetFleetPool(provider string, update api.FleetPoolUpdate) (*api.FleetPool, error)
}

// runFleetSet applies the update to the provider's pool and returns the pool as it now is.
func runFleetSet(c fleetSetClient, provider string, update api.FleetPoolUpdate) (MutationResult, error) {
	result := MutationResult{ID: provider, Kind: fleetPoolKind, Action: ResultUpdated}
	pool, err := c.SetFleetPool(provider, update)
	if err != nil {
		return result, err
	}
	if pool == nil {
		return result, clierr.New(clierr.CodeInternal, "the control plane accepted the update but returned no pool")
	}
	result.Object = pool
	return result, nil
}

// enabledLabel renders a pool's enabled state as a word for the confirmation line.
func enabledLabel(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "paused"
}

func init() {
	addYesFlag(fleetSetCmd, &fleetSetYes)
	fleetSetCmd.Flags().IntVar(&fleetWarmMin, "warm-min", 0, mustGovField("alethia fleet set", fieldKeyFleetWarmMin).Description)
	fleetSetCmd.Flags().IntVar(&fleetMax, "max", 0, mustGovField("alethia fleet set", fieldKeyFleetMax).Description)
	fleetSetCmd.Flags().IntVar(&fleetSlots, "slots", 0, mustGovField("alethia fleet set", fieldKeyFleetSlots).Description)
	fleetSetCmd.Flags().BoolVar(&fleetEnabled, "enabled", false, mustGovField("alethia fleet set", fieldKeyFleetEnabled).Description)
	fleetSetCmd.Flags().StringVar(&fleetChannel, "channel", "", mustGovField("alethia fleet set", fieldKeyFleetChannel).Description)
	fleetSetCmd.Flags().StringVar(&fleetVersion, "version", "", mustGovField("alethia fleet set", fieldKeyFleetVersion).Description)

	fleetCmd.AddCommand(fleetListCmd)
	fleetCmd.AddCommand(fleetSetCmd)
	rootCmd.AddCommand(fleetCmd)
}
