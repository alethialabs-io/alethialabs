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

// JSON (.tf.json / .tofu.json) handling.
//
// JSON bodies cannot be walked as a raw syntax tree the way *hclsyntax.Body
// can, so the structured rules (required_providers, backend/cloud, module
// sources, implied-provider recording for data blocks at top level and inside
// check blocks) use hcl's generic schema-based body API, which preserves
// source ranges. The dangerous-key catch-alls instead do a raw JSON token
// sweep at ANY depth — strictly broader than what the schema API could see,
// so .tf.json gets full detection fidelity and no "json-partial-scan" warning
// is needed:
//
//   - ANY object key named "provisioner" is an error;
//   - the keys "external" / "http" / "terraform_remote_state" directly under
//     a "data" key (a data-source type position — top level, inside a check
//     block, or anywhere else) draw the same findings as the native path.
//
// The raw sweep is the ONLY emitter of those findings for JSON (the schema
// walk only records implied providers), so structural and raw detection never
// double-report. Known trade-off (fail-closed by design): a user-data map
// that coincidentally has a "provisioner" key, or a "data" map with an
// "external"/"http"/"terraform_remote_state" key, is flagged too.

var jsonTopSchema = &hcl.BodySchema{
	Blocks: []hcl.BlockHeaderSchema{
		{Type: "terraform"},
		{Type: "resource", LabelNames: []string{"type", "name"}},
		{Type: "ephemeral", LabelNames: []string{"type", "name"}},
		{Type: "data", LabelNames: []string{"type", "name"}},
		{Type: "module", LabelNames: []string{"name"}},
		{Type: "output", LabelNames: []string{"name"}},
		{Type: "provider", LabelNames: []string{"name"}},
		{Type: "check", LabelNames: []string{"name"}},
		{Type: "import"},
	},
}

var jsonImportSchema = &hcl.BodySchema{
	Attributes: []hcl.AttributeSchema{{Name: "to"}},
}

var jsonCheckSchema = &hcl.BodySchema{
	Blocks: []hcl.BlockHeaderSchema{
		{Type: "data", LabelNames: []string{"type", "name"}},
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

// scanJSONFile parses one .tf.json / .tofu.json file and applies the policy
// via the generic hcl body API plus the raw dangerous-key sweep.
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
			case "resource", "ephemeral":
				// `ephemeral` (tofu 1.10+) instantiates a provider at plan like
				// resource/data — gate its implied provider too.
				if len(blk.Labels) > 0 {
					s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange.Start.Line)
				}
				// Only a `resource` provisions anything (see walk.go).
				if blk.Type == "resource" && len(blk.Labels) > 1 {
					s.recordResource(blk.Labels[0], blk.Labels[1], moduleDir)
				}
			case "import":
				s.walkJSONImportBlock(blk, rel)
			case "data":
				// Implied-provider recording only: the external/http/
				// terraform_remote_state findings come from the raw sweep,
				// which covers every depth (see the file comment).
				if len(blk.Labels) > 0 {
					s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange.Start.Line)
				}
			case "module":
				s.walkJSONModuleBlock(blk, rel, moduleDir)
			case "output":
				// Root-module output names for the BYO-IaC binding picker (#687);
				// recordOutput ignores child-module outputs. Value never read.
				if len(blk.Labels) > 0 {
					s.recordOutput(blk.Labels[0], moduleDir)
				}
			case "provider":
				if len(blk.Labels) > 0 {
					s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange.Start.Line)
				}
			case "check":
				s.walkJSONCheckBlock(blk, rel)
			}
		}
	}

	s.sweepJSONDangerousKeys(path, rel)
}

// walkJSONCheckBlock records the implied provider of every data block scoped
// inside a check{} block — those data sources resolve during plan exactly
// like top-level ones. The dangerous-type findings themselves come from the
// raw sweep.
func (s *scanner) walkJSONCheckBlock(blk *hcl.Block, rel string) {
	content, _, diags := blk.Body.PartialContent(jsonCheckSchema)
	if diags.HasErrors() {
		s.addParseFindings(rel, diags)
	}
	if content == nil {
		return
	}
	for _, inner := range content.Blocks {
		if inner.Type == "data" && len(inner.Labels) > 0 {
			s.recordImpliedUse(inner.Labels[0], rel, inner.DefRange.Start.Line)
		}
	}
}

// walkJSONImportBlock resolves the provider implied by a JSON import block's
// `to` address (a string like "vault_kv_secret_v2.x") and gates it.
func (s *scanner) walkJSONImportBlock(blk *hcl.Block, rel string) {
	content, _, diags := blk.Body.PartialContent(jsonImportSchema)
	if diags.HasErrors() || content == nil {
		return
	}
	attr, ok := content.Attributes["to"]
	if !ok {
		return
	}
	line := attr.Range.Start.Line
	// In JSON the `to` traversal is expressed as a string address; the resource
	// type is the second-to-last dotted segment (address ends in TYPE.NAME).
	if v, d := attr.Expr.Value(nil); !d.HasErrors() && v.Type().Equals(cty.String) && !v.IsNull() {
		if t := resourceTypeFromSegments(splitDots(v.AsString())); t != "" {
			s.recordImpliedUse(t, rel, line)
		}
		return
	}
	// Non-literal `to` (a traversal expression in JSON): use the same segment rule.
	for _, v := range attr.Expr.Variables() {
		if t := resourceTypeFromSegments(traversalNames(v)); t != "" {
			s.recordImpliedUse(t, rel, line)
			return
		}
	}
}

// splitDots splits a dotted address into its segments.
func splitDots(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '.' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
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
	callName := ""
	if len(blk.Labels) > 0 {
		callName = blk.Labels[0]
	}
	s.recordModuleSource(v.AsString(), rel, attr.Range.Start.Line, moduleDir, callName)
}

// sweepJSONDangerousKeys re-reads the raw JSON and flags, at any depth and
// with a real line number: every object key named "provisioner", and every
// data-source-type key ("external" / "http" / "terraform_remote_state")
// directly under a "data" key.
func (s *scanner) sweepJSONDangerousKeys(path, rel string) {
	data, err := os.ReadFile(path)
	if err != nil {
		s.addFinding(SeverityError, RuleParseError, rel, 0, "re-reading file for dangerous-key sweep: "+err.Error())
		return
	}
	hits, err := jsonDangerousKeys(data)
	if err != nil {
		s.addFinding(SeverityError, RuleParseError, rel, 0, "dangerous-key sweep: "+err.Error())
		return
	}
	for _, hit := range hits {
		switch hit.key {
		case "provisioner":
			s.addFinding(SeverityError, RuleProvisionerBlock, rel, hit.line,
				`"provisioner" key: provisioners execute arbitrary commands`)
		case "external":
			s.addFinding(SeverityError, RuleExternalDataSource, rel, hit.line,
				`data "external" executes an arbitrary program during plan`)
		case "http":
			s.addFinding(SeverityWarning, RuleHTTPDataSource, rel, hit.line,
				`data "http" performs network requests during plan`)
		case "terraform_remote_state":
			s.addFinding(SeverityWarning, RuleRemoteStateDataSource, rel, hit.line,
				`data "terraform_remote_state" reads arbitrary remote state during plan`)
		}
	}
}

// jsonKeyHit is one dangerous object key found by the raw JSON sweep.
type jsonKeyHit struct {
	key  string // the matched object key
	line int    // 1-based line of the key
}

// jsonDataSourceKeys are the data-source types the policy flags when they
// appear directly under a "data" key in JSON config.
var jsonDataSourceKeys = map[string]bool{
	"external":               true,
	"http":                   true,
	"terraform_remote_state": true,
}

// jsonDangerousKeys streams JSON tokens and returns every dangerous object
// key at any nesting depth: "provisioner" anywhere, and any key in
// jsonDataSourceKeys whose enclosing container is the value of a "data" key.
// Arrays propagate their key downward (hcl JSON treats an array of objects as
// repeated blocks, so `"data": [{"external": …}]` must match too).
func jsonDangerousKeys(data []byte) ([]jsonKeyHit, error) {
	type frame struct {
		isObject     bool
		keyNext      bool
		containerKey string // the object key whose value this container is ("" at root)
		pendingKey   string // last key read in this object, awaiting its value
	}
	var (
		stack []frame
		out   []jsonKeyHit
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
			case '{', '[':
				containerKey := ""
				if len(stack) > 0 {
					if parent := stack[len(stack)-1]; parent.isObject {
						containerKey = parent.pendingKey
					} else {
						// Array element: inherit the array's own key so
						// repeated-block syntax keeps the "data" context.
						containerKey = parent.containerKey
					}
				}
				stack = append(stack, frame{isObject: d == '{', keyNext: d == '{', containerKey: containerKey})
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
			if k, ok := tok.(string); ok {
				if k == "provisioner" || (top.containerKey == "data" && jsonDataSourceKeys[k]) {
					out = append(out, jsonKeyHit{key: k, line: lineAtOffset(data, dec.InputOffset())})
				}
				top.pendingKey = k
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
