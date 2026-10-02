// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import (
	"encoding/json"
	"flag"
	"os"
	"reflect"
	"testing"
)

// The Go/TS nearest-instance parity fixture (#5267).
//
// Two implementations answer "which machine does this node_size buy": NearestInstance here, which
// is what the deploy actually provisions, and `nearestInstance` in the console's generated
// catalog.ts, which is what the cluster card SHOWS ("4 vCPU / 16 GB → e2-standard-4"). If they
// disagree the card names a machine the cluster does not get — the exact class of lie #5267 was
// filed about. Nothing locked them together: each side had its own property tests.
//
// So the Go answers over a fixed grid are written to testdata/nearest-instance-parity.json, this
// test fails when Go's answers move without the file, and the console's
// tests/lib/cloud-providers/nearest-instance-parity.test.ts fails when TS disagrees with the file.
// Changing the rule therefore reds one side until BOTH are changed. Regenerate after a deliberate
// change to the rule or the inventory with:
//
//	go test ./packages/core/catalog -run TestNearestInstanceParityFixture -update
var updateParity = flag.Bool("update", false, "rewrite testdata/nearest-instance-parity.json from the Go resolver")

const parityFixture = "testdata/nearest-instance-parity.json"

// parityCase is one (request → answer) row of the shared fixture. Family "" means "no family".
type parityCase struct {
	Provider string  `json:"provider"`
	VCPU     float64 `json:"vcpu"`
	MemoryGB float64 `json:"memory_gb"`
	Family   string  `json:"family"`
	Want     string  `json:"want"`
}

// parityGrid is every request the fixture covers: each catalog provider, a spread of shapes that
// includes exact hits, ties and far-off requests, and the family arms (general as the resolver
// asks, none, and a family only some clouds have).
func parityGrid(c *Catalog) []parityCase {
	var out []parityCase
	for _, p := range c.Providers {
		for _, v := range []float64{1, 2, 3, 4, 8, 12} {
			for _, m := range []float64{1, 4, 6, 8, 16, 32, 85} {
				for _, f := range []string{"general", "", "gpu"} {
					in, ok := c.NearestInstance(p.Slug, v, m, f)
					if !ok {
						continue
					}
					out = append(out, parityCase{p.Slug, v, m, f, in.Value})
				}
			}
		}
	}
	return out
}

// TestNearestInstanceParityFixture fails when the Go resolver's answers and the checked-in parity
// fixture disagree, in EITHER direction: a moved answer, and a grid row added or dropped.
func TestNearestInstanceParityFixture(t *testing.T) {
	got := parityGrid(MustLoad())
	if len(got) == 0 {
		t.Fatal("the parity grid is empty — the catalog has no compute inventory to compare")
	}
	if *updateParity {
		b, err := json.MarshalIndent(got, "", "\t")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(parityFixture, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(parityFixture)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate with -update)", parityFixture, err)
	}
	var want []parityCase
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("parse %s: %v", parityFixture, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("NearestInstance no longer matches %s. If the change is deliberate, regenerate it "+
			"with -update AND make the console's nearestInstance agree (its parity test reads the same file).",
			parityFixture)
	}
}
