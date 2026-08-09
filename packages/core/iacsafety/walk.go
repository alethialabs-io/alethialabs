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
		case "resource", "ephemeral":
			// `ephemeral` (tofu 1.10+) instantiates a provider at plan time exactly
			// like `resource`/`data`, so its implied provider must be gated too.
			if len(blk.Labels) > 0 {
				s.recordImpliedUse(blk.Labels[0], rel, blk.DefRange().Start.Line)
			}
			s.recordProviderMetaArg(blk.Body, rel)
			// Only a `resource` provisions anything, so only a resource enters the
			// architecture inventory — an `ephemeral` block is gated, not drawn.
			if blk.Type == "resource" && len(blk.Labels) > 1 {
				s.recordResource(blk.Labels[0], blk.Labels[1], moduleDir)
			}
		case "module":
			s.walkModuleBlock(blk, rel, moduleDir)
		case "output":
			// Root-module output NAMES feed the BYO-IaC binding picker (#687);
			// recordOutput ignores child-module outputs. The value is never read.
			if len(blk.Labels) > 0 {
				s.recordOutput(blk.Labels[0], moduleDir)
			}
		case "provider":
			// A provider block's label IS the provider local name — record it
			// verbatim, never via the type-prefix underscore split.
			if len(blk.Labels) > 0 {
				s.recordImpliedProviderRef(blk.Labels[0], rel, blk.DefRange().Start.Line)
			}
			s.sweepProviderExec(blk.Body, rel)
		case "import":
			// `import` (tofu 1.5+) pulls in the provider of the `to` address's
			// resource type at init/plan, so gate the implied provider from it.
			s.checkImportBlock(blk, rel)
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

// sweepProviderExec recursively flags any `exec` block or attribute inside a
// provider configuration body. The exec credential plugin runs `command` with
// `args` as a local subprocess while the provider configures its client during
// plan — hashicorp/kubernetes accepts it directly, hashicorp/helm nested under
// kubernetes{}, and both are allowlisted, so this is plan-time command
// execution reachable with zero non-allowlisted providers (#2031). Deliberately
// scoped to provider bodies: an exec block inside a RESOURCE (a Kubernetes
// liveness-probe exec, say) is workload configuration that runs in the
// cluster, not on the runner, and must not be flagged.
func (s *scanner) sweepProviderExec(body *hclsyntax.Body, rel string) {
	for name, attr := range body.Attributes {
		if name == "exec" {
			s.addFinding(SeverityError, RuleExecCredentialPlugin, rel, attr.SrcRange.Start.Line,
				"exec attribute in a provider configuration: the exec credential plugin runs an arbitrary command during plan")
		}
	}
	for _, blk := range body.Blocks {
		if blk.Type == "exec" {
			s.addFinding(SeverityError, RuleExecCredentialPlugin, rel, blk.DefRange().Start.Line,
				"exec block in a provider configuration: the exec credential plugin runs an arbitrary command during plan")
		}
		s.sweepProviderExec(blk.Body, rel)
	}
}

// recordProviderMetaArg gates the provider a resource/data/ephemeral block
// pins with its `provider =` meta-argument. OpenTofu derives the block's
// provider local name from that reference when one is present — the type
// prefix applies only in its absence — so `provider = evilprov` on an
// allowlisted resource type makes the module require hashicorp/evilprov,
// which init downloads and executes (#2030). The reference is a traversal
// (`name` or `name.alias`); its root is the local name, taken verbatim.
func (s *scanner) recordProviderMetaArg(body *hclsyntax.Body, rel string) {
	attr, ok := body.Attributes["provider"]
	if !ok {
		return
	}
	line := attr.SrcRange.Start.Line
	for _, v := range attr.Expr.Variables() {
		if segs := traversalNames(v); len(segs) > 0 {
			s.recordImpliedProviderRef(segs[0], rel, line)
			return
		}
	}
}

// checkImportBlock resolves the provider implied by an import block's `to`
// address (e.g. `to = vault_kv_secret_v2.x` implies the vault provider) and
// gates it. The `to` expression is a resource traversal, not a literal, so we
// read the root type name from its variable traversal rather than evaluating it.
func (s *scanner) checkImportBlock(blk *hclsyntax.Block, rel string) {
	attr, ok := blk.Body.Attributes["to"]
	if !ok {
		return
	}
	line := attr.SrcRange.Start.Line
	// A resource address (`vault_kv_secret_v2.x`, `module.m.aws_s3_bucket.b`,
	// `module.a.module.b.aws_s3_bucket.b`) parses as a scope traversal. A resource
	// address always ends in `TYPE.NAME`, so the resource type is the second-to-last
	// segment regardless of how many module hops precede it.
	for _, v := range attr.Expr.Variables() {
		segs := traversalNames(v)
		if t := resourceTypeFromSegments(segs); t != "" {
			s.recordImpliedUse(t, rel, line)
			return
		}
	}
}

// traversalNames flattens a traversal into its root + attribute name segments.
func traversalNames(v hcl.Traversal) []string {
	var out []string
	for _, step := range v {
		switch t := step.(type) {
		case hcl.TraverseRoot:
			out = append(out, t.Name)
		case hcl.TraverseAttr:
			out = append(out, t.Name)
		}
	}
	return out
}

// resourceTypeFromSegments returns the resource type from a dotted address's
// name segments. A resource address ends in TYPE.NAME, so the type is the
// second-to-last segment; "" when the address is too short to be a resource.
func resourceTypeFromSegments(segs []string) string {
	if len(segs) < 2 {
		return ""
	}
	return segs[len(segs)-2]
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
	callName := ""
	if len(blk.Labels) > 0 {
		callName = blk.Labels[0]
	}
	s.recordModuleSource(v.AsString(), rel, attr.SrcRange.Start.Line, moduleDir, callName)
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
			s.recordProviderMetaArg(blk.Body, rel)
		}
		s.sweepBody(blk.Body, rel)
	}
}
