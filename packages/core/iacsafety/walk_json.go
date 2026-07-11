// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/hashicorp/hcl/v2"
	"github.com/zclconf/go-cty/cty"
)

// JSON (.tf.json) handling.
//
// JSON bodies cannot be walked as a raw syntax tree the way *hclsyntax.Body
// can, so the structured rules (required_providers, backend/cloud, data
// sources, module sources) use hcl's generic schema-based body API, which
// preserves source ranges. The provisioner catch-all (rule 2) instead does a
// raw JSON token sweep for ANY object key named "provisioner" at ANY depth —
// strictly broader than what the schema API could see, so .tf.json gets full
// detection fidelity and no "json-partial-scan" warning is needed. Known
// trade-off (fail-closed by design): a user-data map that coincidentally has
// a "provisioner" key is flagged too.

var jsonTopSchema = &hcl.BodySchema{
	Blocks: []hcl.BlockHeaderSchema{
		{Type: "terraform"},
		{Type: "resource", LabelNames: []string{"type", "name"}},
		{Type: "data", LabelNames: []string{"type", "name"}},
		{Type: "module", LabelNames: []string{"name"}},
		{Type: "provider", LabelNames: []string{"name"}},
	},
}

var jsonTerraformSchema = &hcl.BodySchema{
	Blocks: []hcl.BlockHeaderSchema{
		{Type: "required_providers"},
		{Type: "backend", LabelNames: []string{"type"}},
		{Type: "cloud"},
	},
}

var jsonModuleSchema = &hcl.BodySchema{
	Attributes: []hcl.AttributeSchema{{Name: "source"}},
}

// scanJSONFile parses one .tf.json file and applies the policy via the
// generic hcl body API plus the raw provisioner key sweep.
func (s *scanner) scanJSONFile(path, moduleDir string) {
	rel := s.relPath(path)
	file, diags := s.parser.ParseJSONFile(path)
	if diags.HasErrors() {
		s.addParseFindings(rel, diags)
		return
	}

	content, _, diags := file.Body.PartialContent(jsonTopSchema)
	if diags.HasErrors() {
		// Structural mismatch (e.g. "resource" is not an object): we cannot
		// vouch for what we cannot decode — fail closed.
		s.addParseFindings(rel, diags)
	}
	if content != nil {
		for _, blk := range content.Blocks {
			switch blk.Type {
			case "terraform":
				s.walkJSONTerraformBlock(blk, rel)
			case "resource":
				if len(blk.Labels) > 0 {
					s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange.Start.Line)
				}
			case "data":
				s.checkDataBlock(blk.Labels, rel, blk.DefRange.Start.Line)
			case "module":
				s.walkJSONModuleBlock(blk, rel, moduleDir)
			case "provider":
				if len(blk.Labels) > 0 {
					s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange.Start.Line)
				}
			}
		}
	}

	s.sweepJSONProvisioners(path, rel)
}

// walkJSONTerraformBlock handles a terraform{} block from a .tf.json file.
func (s *scanner) walkJSONTerraformBlock(blk *hcl.Block, rel string) {
	content, _, diags := blk.Body.PartialContent(jsonTerraformSchema)
	if diags.HasErrors() {
		s.addParseFindings(rel, diags)
	}
	if content == nil {
		return
	}
	for _, inner := range content.Blocks {
		switch inner.Type {
		case "required_providers":
			attrs, diags := inner.Body.JustAttributes()
			if diags.HasErrors() {
				s.addParseFindings(rel, diags)
				continue
			}
			for name, attr := range attrs {
				s.checkProviderEntry(name, attr.Expr, rel, attr.Range.Start.Line)
			}
		case "backend", "cloud":
			s.addFinding(SeverityWarning, RuleBackendDeclared, rel, inner.DefRange.Start.Line,
				inner.Type+" configuration is declared but will be overridden by the platform backend")
		}
	}
}

// walkJSONModuleBlock extracts a module source from a .tf.json module block.
func (s *scanner) walkJSONModuleBlock(blk *hcl.Block, rel, moduleDir string) {
	content, _, diags := blk.Body.PartialContent(jsonModuleSchema)
	if diags.HasErrors() || content == nil {
		s.addFinding(SeverityError, RuleModuleSourceUnresolvable, rel, blk.DefRange.Start.Line,
			"module block source could not be decoded")
		return
	}
	attr, ok := content.Attributes["source"]
	if !ok {
		s.addFinding(SeverityError, RuleModuleSourceUnresolvable, rel, blk.DefRange.Start.Line,
			"module block has no source attribute")
		return
	}
	v, valDiags := attr.Expr.Value(nil)
	if valDiags.HasErrors() || v.IsNull() || !v.IsKnown() || !v.Type().Equals(cty.String) {
		s.addFinding(SeverityError, RuleModuleSourceUnresolvable, rel, attr.Range.Start.Line,
			"module source is not a static string literal and cannot be verified")
		return
	}
	s.recordModuleSource(v.AsString(), rel, attr.Range.Start.Line, moduleDir)
}

// sweepJSONProvisioners re-reads the raw JSON and flags every object key
// named "provisioner" at any depth, with a real line number.
func (s *scanner) sweepJSONProvisioners(path, rel string) {
	data, err := os.ReadFile(path)
	if err != nil {
		s.addFinding(SeverityError, RuleParseError, rel, 0, "re-reading file for provisioner sweep: "+err.Error())
		return
	}
	lines, err := jsonKeyLines(data, "provisioner")
	if err != nil {
		s.addFinding(SeverityError, RuleParseError, rel, 0, "provisioner sweep: "+err.Error())
		return
	}
	for _, line := range lines {
		s.addFinding(SeverityError, RuleProvisionerBlock, rel, line,
			`"provisioner" key: provisioners execute arbitrary commands`)
	}
}

// jsonKeyLines streams JSON tokens and returns the 1-based line number of
// every object key equal to key, at any nesting depth.
func jsonKeyLines(data []byte, key string) ([]int, error) {
	type frame struct {
		isObject bool
		keyNext  bool
	}
	var (
		stack []frame
		out   []int
	)
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			// json.Decoder.Token reports plain io.EOF between tokens even when
			// containers are still open — treat a non-empty stack as truncation.
			if len(stack) != 0 {
				return out, io.ErrUnexpectedEOF
			}
			return out, nil
		}
		if err != nil {
			return out, err
		}
		if d, ok := tok.(json.Delim); ok {
			switch d {
			case '{':
				stack = append(stack, frame{isObject: true, keyNext: true})
			case '[':
				stack = append(stack, frame{isObject: false})
			case '}', ']':
				stack = stack[:len(stack)-1]
				if len(stack) > 0 && stack[len(stack)-1].isObject {
					// The closed container was a value; the parent expects a key next.
					stack[len(stack)-1].keyNext = true
				}
			}
			continue
		}
		if len(stack) == 0 || !stack[len(stack)-1].isObject {
			continue // scalar at top level or array element
		}
		top := &stack[len(stack)-1]
		if top.keyNext {
			if s, ok := tok.(string); ok && s == key {
				out = append(out, lineAtOffset(data, dec.InputOffset()))
			}
			top.keyNext = false
		} else {
			top.keyNext = true // scalar value consumed; a key follows
		}
	}
}

// lineAtOffset returns the 1-based line containing the given byte offset.
func lineAtOffset(data []byte, off int64) int {
	if off > int64(len(data)) {
		off = int64(len(data))
	}
	return 1 + bytes.Count(data[:off], []byte{'\n'})
}
