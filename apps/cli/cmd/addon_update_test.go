// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// #6537: a catalogue bump does not move a pinned or a GitOps-mode install, so `addon list` is
// where they hear of one. These pin the Update column and the security lines under the table.

// addonUpdateView is an environment with one install of each update shape.
func addonUpdateView() *api.ProjectAddons {
	pin, cur := "4.11.2", "61.9.0"
	summary := "Fixes CVE-2025-1974."
	url := "https://kubernetes.io/blog/2025/03/24/ingress-nginx-cve-2025-1974/"
	return &api.ProjectAddons{
		Environment: "production",
		Addons: []api.Addon{
			{AddonID: "ingress-nginx", Enabled: true, Mode: "managed", Version: &pin, VersionPinned: true, Status: "READY",
				Update: &api.AddonUpdate{Kind: "pin-behind", CatalogVersion: "4.15.1", Security: true, SecuritySummary: &summary, AdvisoryURL: &url}},
			{AddonID: "loki", Enabled: true, Mode: "gitops", Version: &cur, Status: "READY",
				Update: &api.AddonUpdate{Kind: "gitops", CatalogVersion: "6.6.0"}},
			{AddonID: "kube-prometheus-stack", Enabled: true, Mode: "managed", Version: &cur, Status: "READY"},
		},
	}
}

// TestAddonUpdateCell_StatesTheOfferAndMarksSecurity covers each shape of the cell.
func TestAddonUpdateCell_StatesTheOfferAndMarksSecurity(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   *api.AddonUpdate
		want string
	}{
		{"follows the catalogue", nil, ""},
		{"pin behind", &api.AddonUpdate{Kind: "pin-behind", CatalogVersion: "4.15.1"}, "4.15.1 available"},
		{"pin behind, security", &api.AddonUpdate{Kind: "pin-behind", CatalogVersion: "4.15.1", Security: true}, "SECURITY 4.15.1 available"},
		{"gitops", &api.AddonUpdate{Kind: "gitops", CatalogVersion: "4.15.1"}, "repo decides (catalog 4.15.1)"},
		{"gitops, security", &api.AddonUpdate{Kind: "gitops", CatalogVersion: "4.15.1", Security: true}, "SECURITY repo decides (catalog 4.15.1)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := addonUpdateCell(tc.in); got != tc.want {
				t.Errorf("addonUpdateCell = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestRunAddonList_ShowsTheUpdateAndTheSecurityCommand drives the rendered table: the Update
// column carries the offer, and a security update gets a line naming the exact command — which
// updates the pin only when the user runs it.
func TestRunAddonList_ShowsTheUpdateAndTheSecurityCommand(t *testing.T) {
	c := &fakeClient{addons: addonUpdateView()}
	var buf bytes.Buffer
	if err := runAddonList(c, &buf, ui.FormatTable, "web", "production"); err != nil {
		t.Fatalf("runAddonList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		"Update",
		"SECURITY 4.15.1 available",
		"repo decides (catalog 6.6.0)",
		"alethia addon enable ingress-nginx --version 4.15.1 --project web --env production",
		"Fixes CVE-2025-1974.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered output is missing %q:\n%s", want, out)
		}
	}
	// Only a SECURITY update earns a line under the table; an ordinary gitops offer stays a cell.
	if strings.Contains(out, "loki: ") {
		t.Errorf("a non-security update printed a notice line:\n%s", out)
	}
}

// TestRunAddonList_CSVCarriesNoProseLine: a notice line in CSV would be a malformed row.
func TestRunAddonList_CSVCarriesNoProseLine(t *testing.T) {
	c := &fakeClient{addons: addonUpdateView()}
	var buf bytes.Buffer
	if err := runAddonList(c, &buf, ui.FormatCSV, "web", "production"); err != nil {
		t.Fatalf("runAddonList: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "alethia addon enable") {
		t.Errorf("CSV output carries the security notice line:\n%s", out)
	}
	if !strings.Contains(out, "SECURITY 4.15.1 available") {
		t.Errorf("CSV output lost the Update cell:\n%s", out)
	}
}

// TestAddonSecurityNotices_GitOpsNamesTheFileNotACommand: the CLI cannot pin a GitOps install's
// version — the repo decides — so its line names the file and field to change.
func TestAddonSecurityNotices_GitOpsNamesTheFileNotACommand(t *testing.T) {
	v := "4.11.2"
	lines := addonSecurityNotices([]api.Addon{{AddonID: "ingress-nginx", Mode: "gitops", Version: &v,
		Update: &api.AddonUpdate{Kind: "gitops", CatalogVersion: "4.15.1", Security: true}}}, "web", "")
	if len(lines) != 1 {
		t.Fatalf("want one line, got %q", lines)
	}
	if !strings.Contains(lines[0], "addons/ingress-nginx.yaml") || !strings.Contains(lines[0], "spec.source.targetRevision") {
		t.Errorf("the GitOps line does not name the file and field: %q", lines[0])
	}
	if strings.Contains(lines[0], "alethia addon enable") {
		t.Errorf("the GitOps line offers a pin command that would not move the repo: %q", lines[0])
	}
}
