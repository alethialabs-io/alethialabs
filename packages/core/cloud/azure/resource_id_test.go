// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package azure

import "testing"

// TestParseResourceID exercises the pure resource-ID parser across happy paths,
// case-insensitivity, missing segments, malformed/empty inputs and edge cases.
func TestParseResourceID(t *testing.T) {
	tests := []struct {
		name    string
		id      string
		wantRG  string
		wantNS  string // ResourceName
		wantErr bool
	}{
		{
			name:   "full vnet id",
			id:     "/subscriptions/sub-123/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet",
			wantRG: "my-rg",
			wantNS: "my-vnet",
		},
		{
			name:   "case-insensitive resourcegroups segment",
			id:     "/subscriptions/sub/RESOURCEGROUPS/rg2/providers/x/y/name2",
			wantRG: "rg2",
			wantNS: "name2",
		},
		{
			name:   "no leading slash",
			id:     "subscriptions/sub/resourceGroups/rg3/providers/foo/bar/name3",
			wantRG: "rg3",
			wantNS: "name3",
		},
		{
			name:   "minimal rg and name",
			id:     "/resourceGroups/rg/name",
			wantRG: "rg",
			wantNS: "name",
		},
		{
			name:   "duplicate resourcegroups takes last occurrence",
			id:     "/resourceGroups/first/resourceGroups/second/name",
			wantRG: "second",
			wantNS: "name",
		},
		{
			name:    "missing resource group",
			id:      "/subscriptions/sub/providers/Microsoft.Network/virtualNetworks/name",
			wantErr: true,
		},
		{
			name:    "trailing slash empties resource name",
			id:      "/subscriptions/sub/resourceGroups/rg/providers/x/y/",
			wantErr: true,
		},
		{
			name:    "empty string",
			id:      "",
			wantErr: true,
		},
		{
			name:    "resourcegroups as last element (no value)",
			id:      "/x/resourceGroups",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseResourceID(tt.id)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ParseResourceID(%q) = %+v, want error", tt.id, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseResourceID(%q) unexpected error: %v", tt.id, err)
			}
			if got.ResourceGroup != tt.wantRG {
				t.Errorf("ParseResourceID(%q) ResourceGroup = %q, want %q", tt.id, got.ResourceGroup, tt.wantRG)
			}
			if got.ResourceName != tt.wantNS {
				t.Errorf("ParseResourceID(%q) ResourceName = %q, want %q", tt.id, got.ResourceName, tt.wantNS)
			}
		})
	}
}
