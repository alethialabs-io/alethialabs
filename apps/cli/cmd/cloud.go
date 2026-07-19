// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var cloudCmd = &cobra.Command{
	Use:   "cloud",
	Short: "Inspect discovered cloud resources",
	Long: `Alethia inventories the networking (VPCs/VNets, subnets) and regions it discovers in a
connected cloud account. Show that inventory for a cloud identity.`,
}

var cloudInventoryCmd = &cobra.Command{
	Use:   "inventory <cloud-identity-id>",
	Short: "Show the discovered networking + regions for a cloud identity",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runCloudInventory(api.NewClient(token), os.Stdout, outputFormat(cmd), args[0]); err != nil {
			failf("Failed to get cloud inventory: %v", err)
		}
	},
}

var networkColumns = []string{"Network", "Name", "Region", "CIDR", "Default"}
var subnetColumns = []string{"Subnet", "Name", "Region", "AZ", "CIDR", "Public"}

// networkRows projects discovered networks into plain table cells.
func networkRows(networks []api.CloudNetwork) [][]string {
	rows := make([][]string, len(networks))
	for i, n := range networks {
		rows[i] = []string{n.NativeID, strOrDash(n.Name), strOrDash(n.Region), strOrDash(n.CidrBlock), gateGlyph(n.IsDefault)}
	}
	return rows
}

// subnetRows projects discovered subnets into plain table cells.
func subnetRows(subnets []api.CloudSubnet) [][]string {
	rows := make([][]string, len(subnets))
	for i, s := range subnets {
		rows[i] = []string{s.NativeID, strOrDash(s.Name), strOrDash(s.Region), strOrDash(s.AvailabilityZone), strOrDash(s.CidrBlock), gateGlyph(s.IsPublic)}
	}
	return rows
}

// runCloudInventory fetches and renders a cloud identity's discovered inventory. json emits the
// whole object; table renders the networks + subnets tables and a regions line; csv emits the
// networks rows (the primary set).
func runCloudInventory(c apiClient, out io.Writer, format, cloudIdentityID string) error {
	inv, err := c.GetCloudInventory(cloudIdentityID)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, inv)
	}
	if len(inv.Networks) == 0 && len(inv.Subnets) == 0 && len(inv.Regions) == 0 {
		fmt.Fprintln(out, ui.MutedStyle.Render("No cloud inventory discovered yet."))
		return nil
	}
	if format == ui.FormatCSV {
		return ui.Render(out, format, ui.TableSpec{Columns: networkColumns, Rows: networkRows(inv.Networks)}, inv.Networks)
	}
	// Table: networks, then subnets, then a regions line.
	fmt.Fprintln(out, ui.MutedStyle.Render("Networks"))
	_ = ui.Render(out, format, ui.TableSpec{Columns: networkColumns, Rows: networkRows(inv.Networks)}, inv.Networks)
	fmt.Fprintln(out)
	fmt.Fprintln(out, ui.MutedStyle.Render("Subnets"))
	_ = ui.Render(out, format, ui.TableSpec{Columns: subnetColumns, Rows: subnetRows(inv.Subnets)}, inv.Subnets)
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
