// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"reflect"
	"testing"
)

func TestSelectBrownfieldSubnets(t *testing.T) {
	discovered := []SubnetMeta{
		{ID: "subnet-priv-a", Public: false},
		{ID: "subnet-pub-a", Public: true},
		{ID: "subnet-priv-b", Public: false},
	}

	tests := []struct {
		name        string
		discovered  []SubnetMeta
		selected    []string
		wantPrivate []string
		wantPublic  []string
	}{
		{
			name:        "no selection uses all discovered, partitioned",
			discovered:  discovered,
			selected:    nil,
			wantPrivate: []string{"subnet-priv-a", "subnet-priv-b"},
			wantPublic:  []string{"subnet-pub-a"},
		},
		{
			name:        "selection restricts to chosen ids, in selection order",
			discovered:  discovered,
			selected:    []string{"subnet-priv-b", "subnet-pub-a"},
			wantPrivate: []string{"subnet-priv-b"},
			wantPublic:  []string{"subnet-pub-a"},
		},
		{
			name:        "selected id not among discovered is dropped",
			discovered:  discovered,
			selected:    []string{"subnet-priv-a", "subnet-does-not-exist"},
			wantPrivate: []string{"subnet-priv-a"},
			wantPublic:  []string{"subnet-priv-a"}, // empty public side mirrors private
		},
		{
			name:        "only-private VPC mirrors private into public",
			discovered:  []SubnetMeta{{ID: "p1"}, {ID: "p2"}},
			selected:    nil,
			wantPrivate: []string{"p1", "p2"},
			wantPublic:  []string{"p1", "p2"},
		},
		{
			name:        "selection with failed discovery falls back to raw selection in both",
			discovered:  nil,
			selected:    []string{"subnet-x", "subnet-y"},
			wantPrivate: []string{"subnet-x", "subnet-y"},
			wantPublic:  []string{"subnet-x", "subnet-y"},
		},
		{
			name:        "no discovery and no selection stays empty (template guard catches it)",
			discovered:  nil,
			selected:    nil,
			wantPrivate: nil,
			wantPublic:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotPrivate, gotPublic := SelectBrownfieldSubnets(tt.discovered, tt.selected)
			if !reflect.DeepEqual(gotPrivate, tt.wantPrivate) {
				t.Errorf("private = %v, want %v", gotPrivate, tt.wantPrivate)
			}
			if !reflect.DeepEqual(gotPublic, tt.wantPublic) {
				t.Errorf("public = %v, want %v", gotPublic, tt.wantPublic)
			}
		})
	}
}
