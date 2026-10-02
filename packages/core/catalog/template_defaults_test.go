// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclparse"
	"github.com/zclconf/go-cty/cty"
)

// templateRoot is infra/templates/project relative to this package. Relative on purpose: a missing
// directory is a hard failure below, never a skip — a guard that skips when it cannot find its
// subject reports green on exactly the change (a moved template) that should have failed it.
const templateRoot = "../../../infra/templates/project"

// templateNodeVariables names, per cloud, the root-template variables that carry the node
// machine type a cluster gets when its snapshot pins none (`instance_types: []` and no node_size).
//
// Hetzner lists two because its provider moves both pools together (the control plane follows the
// resolved worker type), so the template's two defaults have to agree with the catalog as well.
var templateNodeVariables = map[string][]string{
	"aws":     {"eks_instance_types"},
	"gcp":     {"gke_instance_types"},
	"azure":   {"aks_instance_types"},
	"alibaba": {"ack_instance_types"},
	"hetzner": {"worker_server_type", "control_plane_server_type"},
}

// TestTemplateNodeDefaultsEqualTheCatalog pins the #5266 decision: the catalog is the single source
// of truth for a cluster's default node, and each template's own variable default EQUALS it.
//
// Why the template default matters at all: a cluster row that pins no instance type reaches the
// snapshot as `instance_types: []`, the providers then omit the tfvar, and the template default is
// what gets bought. Before this test those defaults were chosen separately — aws was m5a.4xlarge
// (16 vCPU / 64 GiB, about 17× the catalog's t3.large) — so the same "pin nothing" bought a
// different machine depending on which entry point wrote the project.
//
// The variable is read with the HCL parser, not a regex, so a reformatted block cannot hide it, and
// a variable that is MISSING is a failure, not a pass: renaming `eks_instance_types` must break here.
func TestTemplateNodeDefaultsEqualTheCatalog(t *testing.T) {
	c := MustLoad()

	// Both directions: every cloud with a compute catalog needs a template mapping, and every mapping
	// needs a catalog default. A new cloud added to one side only fails here.
	var catalogClouds, mappedClouds []string
	for p := range c.Compute {
		catalogClouds = append(catalogClouds, p)
	}
	for p := range templateNodeVariables {
		mappedClouds = append(mappedClouds, p)
	}
	sort.Strings(catalogClouds)
	sort.Strings(mappedClouds)
	if !slices.Equal(catalogClouds, mappedClouds) {
		t.Fatalf("catalog compute clouds %v != template mappings %v — add the new cloud's node variable to templateNodeVariables", catalogClouds, mappedClouds)
	}

	for _, provider := range mappedClouds {
		want := c.Compute[provider].DefaultInstance
		if want == "" {
			t.Errorf("%s: catalog has no compute.%s.default_instance", provider, provider)
			continue
		}
		path := filepath.Join(templateRoot, provider, "variables.tf")
		for _, name := range templateNodeVariables[provider] {
			got, err := templateVariableDefault(path, name)
			if err != nil {
				t.Errorf("%s: %v", provider, err)
				continue
			}
			if !slices.Equal(got, []string{want}) {
				t.Errorf("%s: %s variable %q defaults to %v, but the catalog default is %q — they must be equal (#5266); change both together",
					provider, path, name, got, want)
			}
		}
	}
}

// templateVariableDefault parses a variables.tf and returns the default of `variable "<name>"` as a
// list of strings: a string default is a one-element list, a list(string) default is the list.
// Every other outcome is an error: a file that does not parse, a variable that is not there, a
// variable with no default, or a default of another type.
func templateVariableDefault(path, name string) ([]string, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	file, diags := hclparse.NewParser().ParseHCL(src, path)
	if diags.HasErrors() {
		return nil, diags
	}
	content, _, diags := file.Body.PartialContent(&hcl.BodySchema{
		Blocks: []hcl.BlockHeaderSchema{{Type: "variable", LabelNames: []string{"name"}}},
	})
	if diags.HasErrors() {
		return nil, diags
	}
	for _, block := range content.Blocks {
		if block.Labels[0] != name {
			continue
		}
		// PartialContent, not JustAttributes: a variable block also holds `validation` blocks.
		inner, _, diags := block.Body.PartialContent(&hcl.BodySchema{
			Attributes: []hcl.AttributeSchema{{Name: "default"}},
		})
		if diags.HasErrors() {
			return nil, diags
		}
		def, ok := inner.Attributes["default"]
		if !ok {
			return nil, fmt.Errorf("%s: variable %q has no default", path, name)
		}
		val, diags := def.Expr.Value(nil)
		if diags.HasErrors() {
			return nil, diags
		}
		return ctyStrings(val, path, name)
	}
	return nil, fmt.Errorf("%s: variable %q not found — renamed? update templateNodeVariables", path, name)
}

// ctyStrings flattens a string or a list/tuple of strings into a Go slice, refusing anything else.
func ctyStrings(val cty.Value, path, name string) ([]string, error) {
	ty := val.Type()
	switch {
	case ty == cty.String:
		return []string{val.AsString()}, nil
	case ty.IsTupleType() || ty.IsListType():
		var out []string
		for it := val.ElementIterator(); it.Next(); {
			_, el := it.Element()
			if el.Type() != cty.String {
				return nil, fmt.Errorf("%s: variable %q default has a non-string element", path, name)
			}
			out = append(out, el.AsString())
		}
		return out, nil
	}
	return nil, fmt.Errorf("%s: variable %q default is %s, not a string or a list of strings", path, name, ty.FriendlyName())
}
