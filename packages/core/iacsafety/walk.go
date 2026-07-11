// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import (
	"fmt"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
)

// scanNativeFile parses one .tf file with the native HCL syntax parser and
// walks its syntax tree. Expressions are never evaluated against a context;
// literal values are extracted with a nil EvalContext, which fails (and we
// fail closed) for anything non-literal.
func (s *scanner) scanNativeFile(path, moduleDir string) {
	rel := s.relPath(path)
	file, diags := s.parser.ParseHCLFile(path)
	if diags.HasErrors() {
		s.addParseFindings(rel, diags)
		return
	}
	body, ok := file.Body.(*hclsyntax.Body)
	if !ok {
		// hclparse.ParseHCLFile always yields *hclsyntax.Body; guard anyway.
		s.addFinding(SeverityError, RuleParseError, rel, 0, "unexpected non-syntax HCL body")
		return
	}

	for _, blk := range body.Blocks {
		switch blk.Type {
		case "terraform":
			s.walkTerraformBlock(blk, rel)
		case "resource":
			if len(blk.Labels) > 0 {
				s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange().Start.Line)
			}
		case "module":
			s.walkModuleBlock(blk, rel, moduleDir)
		case "provider":
			if len(blk.Labels) > 0 {
				s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange().Start.Line)
			}
		}
	}

	// Catch-all: one recursive sweep over the whole file finds every
	// provisioner block/attribute AND every data block at ANY depth — top
	// level, inside check blocks (where data "external" still executes at
	// plan), dynamic blocks, odd parse positions. Data blocks are handled
	// exclusively here (not in the top-level switch above) so top level and
	// nested positions go through the exact same rules.
	s.sweepBody(body, rel)
}

// addParseFindings converts parse diagnostics into fail-closed error findings.
func (s *scanner) addParseFindings(rel string, diags hcl.Diagnostics) {
	for _, d := range diags {
		line := 0
		if d.Subject != nil {
			line = d.Subject.Start.Line
		}
		s.addFinding(SeverityError, RuleParseError, rel, line, d.Error())
	}
}

// walkTerraformBlock inspects a terraform{} block for required_providers
// entries and backend/cloud declarations.
func (s *scanner) walkTerraformBlock(blk *hclsyntax.Block, rel string) {
	for _, inner := range blk.Body.Blocks {
		switch inner.Type {
		case "required_providers":
			for name, attr := range inner.Body.Attributes {
				s.checkProviderEntry(name, attr.Expr, rel, attr.SrcRange.Start.Line)
			}
		case "backend", "cloud":
			s.addFinding(SeverityWarning, RuleBackendDeclared, rel, inner.DefRange().Start.Line,
				fmt.Sprintf("%s configuration is declared but will be overridden by the platform backend", inner.Type))
		}
	}
}

// checkDataBlock applies the data-source rules: data "external" is code
// execution at plan time (error); data "http" is plan-time network access
// (warning); data "terraform_remote_state" reads arbitrary remote state at
// plan time (warning); every data type also feeds the implied-provider check.
func (s *scanner) checkDataBlock(labels []string, rel string, line int) {
	if len(labels) == 0 {
		return
	}
	switch labels[0] {
	case "external":
		s.addFinding(SeverityError, RuleExternalDataSource, rel, line,
			`data "external" executes an arbitrary program during plan`)
	case "http":
		s.addFinding(SeverityWarning, RuleHTTPDataSource, rel, line,
			`data "http" performs network requests during plan`)
	case "terraform_remote_state":
		s.addFinding(SeverityWarning, RuleRemoteStateDataSource, rel, line,
			`data "terraform_remote_state" reads arbitrary remote state during plan`)
	}
	s.recordImpliedUse(labels[0], rel, line)
}

// walkModuleBlock extracts a module block's source, records it, and enqueues
// local sources for scanning.
func (s *scanner) walkModuleBlock(blk *hclsyntax.Block, rel, moduleDir string) {
	attr, ok := blk.Body.Attributes["source"]
	if !ok {
		s.addFinding(SeverityError, RuleModuleSourceUnresolvable, rel, blk.DefRange().Start.Line,
			"module block has no source attribute")
		return
	}
	v, diags := attr.Expr.Value(nil)
	if diags.HasErrors() || v.IsNull() || !v.IsKnown() || !v.Type().Equals(cty.String) {
		s.addFinding(SeverityError, RuleModuleSourceUnresolvable, rel, attr.SrcRange.Start.Line,
			"module source is not a static string literal and cannot be verified")
		return
	}
	s.recordModuleSource(v.AsString(), rel, attr.SrcRange.Start.Line, moduleDir)
}

// sweepBody recursively sweeps a syntax body, at any nesting depth, for:
//
//   - anything named "provisioner" — block or attribute: provisioners are
//     arbitrary command execution, so any occurrence is an error regardless
//     of where the parser placed it;
//   - every "data" block: check blocks legitimately contain scoped data
//     sources that OpenTofu resolves during plan, so a data "external"
//     nested inside a check block executes exactly like a top-level one and
//     must draw exactly the same findings (including the implied-provider
//     gate). Sweeping every depth fails closed for odd positions too.
func (s *scanner) sweepBody(body *hclsyntax.Body, rel string) {
	for name, attr := range body.Attributes {
		if name == "provisioner" {
			s.addFinding(SeverityError, RuleProvisionerBlock, rel, attr.SrcRange.Start.Line,
				"provisioner attribute: provisioners execute arbitrary commands")
		}
	}
	for _, blk := range body.Blocks {
		switch blk.Type {
		case "provisioner":
			label := ""
			if len(blk.Labels) > 0 {
				label = " \"" + blk.Labels[0] + "\""
			}
			s.addFinding(SeverityError, RuleProvisionerBlock, rel, blk.DefRange().Start.Line,
				fmt.Sprintf("provisioner%s block: provisioners execute arbitrary commands", label))
		case "data":
			s.checkDataBlock(blk.Labels, rel, blk.DefRange().Start.Line)
		}
		s.sweepBody(blk.Body, rel)
	}
}
