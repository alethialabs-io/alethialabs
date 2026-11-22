// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var cloudCmd = &cobra.Command{
	Use:   "cloud",
	Short: "Inspect what Alethia discovered in a connected cloud account",
	Long: `Alethia inventories the networks, subnets and regions of every connected cloud
account. These commands show that inventory.`,
}

// cloudInventoryCmd shows one account's inventory. Its Long names the offered clouds, so it is
// written by applyCloudHelp.
var cloudInventoryCmd = &cobra.Command{
	Use:   "inventory [provider|cloud-identity-id]",
	Short: "Show the networks, subnets and regions discovered in a connected cloud account",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		p := resultPrinter(cmd)
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)

		ref := ""
		if len(args) == 1 {
			ref = args[0]
		}
		identityID, err := resolveCloudIdentityRef(client, ref)
		if err != nil {
			fail(err)
		}

		if err := runCloudInventory(client, p, identityID); err != nil {
			fail(err)
		}
	},
}

var networkColumns = []string{"Network", "Name", "Region", "CIDR", "Default"}
var subnetColumns = []string{"Subnet", "Name", "Region", "AZ", "CIDR", "Public"}

// networkRows projects discovered networks into plain table cells.
func networkRows(networks []api.CloudNetwork, outFmt string) [][]string {
	rows := make([][]string, len(networks))
	for i, n := range networks {
		rows[i] = []string{n.NativeID, ui.Cell(outFmt, ui.Wire(n.Name), ui.StrOrDash(n.Name)), ui.Cell(outFmt, ui.Wire(n.Region), ui.StrOrDash(n.Region)), ui.Cell(outFmt, ui.Wire(n.CidrBlock), ui.StrOrDash(n.CidrBlock)), ui.Cell(outFmt, ui.WireBool(n.IsDefault), ui.GateGlyph(n.IsDefault))}
	}
	return rows
}

// subnetRows projects discovered subnets into plain table cells.
func subnetRows(subnets []api.CloudSubnet, outFmt string) [][]string {
	rows := make([][]string, len(subnets))
	for i, s := range subnets {
		rows[i] = []string{s.NativeID, ui.Cell(outFmt, ui.Wire(s.Name), ui.StrOrDash(s.Name)), ui.Cell(outFmt, ui.Wire(s.Region), ui.StrOrDash(s.Region)), ui.Cell(outFmt, ui.Wire(s.AvailabilityZone), ui.StrOrDash(s.AvailabilityZone)), ui.Cell(outFmt, ui.Wire(s.CidrBlock), ui.StrOrDash(s.CidrBlock)), ui.Cell(outFmt, ui.WireBool(s.IsPublic), ui.GateGlyph(s.IsPublic))}
	}
	return rows
}

// runCloudInventory fetches a cloud identity's discovered inventory and writes it on the Printer's
// stdout. json emits the whole object; table renders the networks and subnets tables and a regions
// line; csv emits the networks rows (the primary set).
//
// An account with nothing discovered yet says so on stderr in the table format, so stdout stays
// empty for a pipeline.
func runCloudInventory(c apiClient, p *Printer, cloudIdentityID string) error {
	inv, err := c.GetCloudInventory(cloudIdentityID)
	if err != nil {
		return fmt.Errorf("failed to get cloud inventory: %w", err)
	}
	out, format := p.Out, p.Format
	if format == ui.FormatJSON {
		return ui.RenderJSON(out, inv)
	}
	if format == ui.FormatCSV {
		return ui.Render(out, format, ui.TableSpec{Columns: networkColumns, Rows: networkRows(inv.Networks, format)}, inv.Networks)
	}
	if len(inv.Networks) == 0 && len(inv.Subnets) == 0 && len(inv.Regions) == 0 {
		p.Note("No cloud inventory discovered yet.")
		return nil
	}
	// Table: networks, then subnets, then a regions line.
	fmt.Fprintln(out, ui.MutedStyle.Render("Networks"))
	if err := ui.Render(out, format, ui.TableSpec{Columns: networkColumns, Rows: networkRows(inv.Networks, format)}, inv.Networks); err != nil {
		return err
	}
	fmt.Fprintln(out)
	fmt.Fprintln(out, ui.MutedStyle.Render("Subnets"))
	if err := ui.Render(out, format, ui.TableSpec{Columns: subnetColumns, Rows: subnetRows(inv.Subnets, format)}, inv.Subnets); err != nil {
		return err
	}
	if len(inv.Regions) > 0 {
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Regions: "+strings.Join(inv.Regions, ", "))
	}
	return nil
}

func init() {
	cloudCmd.AddCommand(cloudInventoryCmd)
	rootCmd.AddCommand(cloudCmd)
}
