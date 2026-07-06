// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// --- billing ---

func sampleBilling() *api.Billing {
	seats := 5
	return &api.Billing{
		Plan: "team", Status: "active", Seats: &seats,
		StripeSubscriptionID: "sub_123", TrialEndsAt: "",
		CurrentPeriodEnd: "2026-02-01T00:00:00.000Z",
	}
}

func TestRunBillingTable(t *testing.T) {
	var buf bytes.Buffer
	if err := runBilling(&fakeClient{billing: sampleBilling()}, &buf, "table"); err != nil {
		t.Fatalf("runBilling: %v", err)
	}
	for _, want := range []string{"team", "active", "5", "sub_123"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("billing table missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunBillingNilSeats(t *testing.T) {
	var buf bytes.Buffer
	b := sampleBilling()
	b.Seats = nil
	if err := runBilling(&fakeClient{billing: b}, &buf, "table"); err != nil {
		t.Fatalf("runBilling: %v", err)
	}
	// A nil seat count renders the dash glyph, not "0".
	if !strings.Contains(buf.String(), "team") {
		t.Errorf("expected plan present: %s", buf.String())
	}
}

func TestRunBillingJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runBilling(&fakeClient{billing: sampleBilling()}, &buf, "json"); err != nil {
		t.Fatalf("runBilling json: %v", err)
	}
	var got api.Billing
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, buf.String())
	}
	if got.Plan != "team" || got.Seats == nil || *got.Seats != 5 {
		t.Errorf("unexpected billing json: %+v", got)
	}
}

func TestRunBillingError(t *testing.T) {
	var buf bytes.Buffer
	if err := runBilling(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- usage ---

func sampleUsage() *api.Usage {
	return &api.Usage{
		SeatsUsed: 3, SeatsCap: 5, RunnerMinutes: 120,
		Projects: 7, AICreditsUsed: 450, AICreditsGranted: 3000,
	}
}

func TestRunUsageTable(t *testing.T) {
	var buf bytes.Buffer
	if err := runUsage(&fakeClient{usage: sampleUsage()}, &buf, "table"); err != nil {
		t.Fatalf("runUsage: %v", err)
	}
	for _, want := range []string{"3 / 5", "120", "7", "450 / 3000"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("usage table missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunUsageJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runUsage(&fakeClient{usage: sampleUsage()}, &buf, "json"); err != nil {
		t.Fatalf("runUsage json: %v", err)
	}
	var got api.Usage
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got.SeatsUsed != 3 || got.AICreditsGranted != 3000 {
		t.Errorf("unexpected usage json: %+v", got)
	}
}

func TestRunUsageError(t *testing.T) {
	var buf bytes.Buffer
	if err := runUsage(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- fleet list ---

func sampleFleetPools() []api.FleetPool {
	return []api.FleetPool{
		{
			Provider: "aws", WarmMin: 1, Max: 10, SlotsPerRunner: 2,
			Locations: []string{"fsn1", "nbg1"}, Surge: 1, Buffer: 1,
			Channel: "stable", Version: "", Enabled: true,
		},
		{
			Provider: "gcp", WarmMin: 0, Max: 5, SlotsPerRunner: 1,
			Locations: []string{"us"}, Version: "v1.2.3", Enabled: false,
		},
	}
}

func TestRunFleetList(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{fleetPools: sampleFleetPools()}, &buf, "table"); err != nil {
		t.Fatalf("runFleetList: %v", err)
	}
	for _, want := range []string{"aws", "gcp", "stable (channel)", "v1.2.3", "fsn1,nbg1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("fleet list missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunFleetListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{fleetPools: sampleFleetPools()}, &buf, "json"); err != nil {
		t.Fatalf("runFleetList json: %v", err)
	}
	var got []api.FleetPool
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 pools, got %d", len(got))
	}
}

func TestRunFleetListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{fleetPools: nil}, &buf, "table"); err != nil {
		t.Fatalf("runFleetList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No fleet pools") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunFleetListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- fleet set ---

func TestRunFleetSet(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{updatedPool: &api.FleetPool{Provider: "aws", WarmMin: 3, Max: 10, Enabled: true}}
	warmMin := 3
	update := api.FleetPoolUpdate{WarmMin: &warmMin}
	if err := runFleetSet(f, &buf, "aws", update); err != nil {
		t.Fatalf("runFleetSet: %v", err)
	}
	if f.setPoolProv != "aws" || f.setPoolUpdate.WarmMin == nil || *f.setPoolUpdate.WarmMin != 3 {
		t.Errorf("update not recorded: %+v", f.setPoolUpdate)
	}
	if !strings.Contains(buf.String(), "Updated aws pool") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunFleetSetError(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetSet(&fakeClient{err: errBoom}, &buf, "aws", api.FleetPoolUpdate{}); err == nil {
		t.Error("expected error propagated")
	}
}

// buildFleetUpdate is exercised through a command carrying the real flags, so the
// flag→pointer mapping (and "only set what changed") is covered.
func newFleetSetTestCmd() *cobra.Command {
	c := &cobra.Command{Use: "set"}
	c.Flags().IntVar(&fleetWarmMin, "warm-min", 0, "")
	c.Flags().IntVar(&fleetMax, "max", 0, "")
	c.Flags().IntVar(&fleetSlots, "slots", 0, "")
	c.Flags().BoolVar(&fleetEnabled, "enabled", false, "")
	c.Flags().StringVar(&fleetChannel, "channel", "", "")
	c.Flags().StringVar(&fleetVersion, "version", "", "")
	return c
}

func TestBuildFleetUpdatePartial(t *testing.T) {
	c := newFleetSetTestCmd()
	if err := c.ParseFlags([]string{"--warm-min", "3", "--enabled=false", "--version", "v2"}); err != nil {
		t.Fatalf("parse flags: %v", err)
	}
	update, changed := buildFleetUpdate(c)
	if !changed {
		t.Fatal("expected changed=true")
	}
	if update.WarmMin == nil || *update.WarmMin != 3 {
		t.Errorf("warm-min not mapped: %+v", update.WarmMin)
	}
	if update.Enabled == nil || *update.Enabled {
		t.Errorf("enabled not mapped: %+v", update.Enabled)
	}
	if update.Version == nil || *update.Version != "v2" {
		t.Errorf("version not mapped: %+v", update.Version)
	}
	if update.Max != nil || update.SlotsPerRunner != nil || update.Channel != nil {
		t.Errorf("unset flags should stay nil: %+v", update)
	}
}

func TestBuildFleetUpdateNoChange(t *testing.T) {
	c := newFleetSetTestCmd()
	if err := c.ParseFlags(nil); err != nil {
		t.Fatalf("parse flags: %v", err)
	}
	if _, changed := buildFleetUpdate(c); changed {
		t.Error("expected changed=false when no flags set")
	}
}

func TestFleetVersionCell(t *testing.T) {
	if got := fleetVersionCell(api.FleetPool{Version: "v1"}); got != "v1" {
		t.Errorf("pinned version: got %q", got)
	}
	if got := fleetVersionCell(api.FleetPool{Channel: "stable"}); got != "stable (channel)" {
		t.Errorf("channel: got %q", got)
	}
	if got := fleetVersionCell(api.FleetPool{}); got == "" {
		t.Error("expected dash for no version/channel")
	}
}
