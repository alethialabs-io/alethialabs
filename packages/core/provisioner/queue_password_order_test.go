// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where the broker-password reconciliation sits in RunDeployV2 is the whole of its correctness, and
// nothing else can see it.
//
// THE TWO BOUNDS. `convergeInClusterQueuePasswords` execs into a Ready broker pod, so:
//
//   - AFTER `WaitAddOnsHealthy`. Before the wait, no broker is Ready on the deploy that creates the
//     queue and few are Ready on one that restarts it, so the reconciliation would skip on every
//     run and defer the repair forever — while reporting "no broker yet" each time, which reads
//     like an environmental hiccup rather than a placement bug.
//   - BEFORE `ReadDataEndpoints`. That read is what PUBLISHES the credential Secret to the console
//     as the queue's endpoint credential. Converging after it publishes the password from #3590 —
//     the one the broker does not accept — and then fixes the broker a moment later, so the console
//     is briefly right about a credential it displayed as wrong. Converging first means the value
//     the console publishes is one that works when it is published.
//
// Moving either statement past its bound compiles, gofmts, lints, and leaves every other test in
// this package green. So the order is asserted structurally, on the source, in the idiom
// argocd_preflight_order_test.go established.
package provisioner

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestQueuePasswordConvergesAfterTheHealthWaitAndBeforeTheEndpointRead(t *testing.T) {
	const file = "deploy.go"
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		// A guard that cannot read its subject has found NOTHING, not "nothing wrong".
		t.Fatalf("could not parse %s, so this guard proved nothing: %v", file, err)
	}

	var fn *ast.FuncDecl
	for _, decl := range parsed.Decls {
		if d, ok := decl.(*ast.FuncDecl); ok && d.Name.Name == "RunDeployV2" && d.Recv == nil {
			fn = d
			break
		}
	}
	if fn == nil || fn.Body == nil {
		t.Fatalf("RunDeployV2 was not found in %s — this guard proved nothing", file)
	}

	// Walk the whole body, so a call nested in an `if` or a closure is located rather than skipped.
	const notFound = -1
	wait, converge, read := notFound, notFound, notFound
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch f := call.Fun.(type) {
		case *ast.SelectorExpr: // argocd.WaitAddOnsHealthy(...), argocd.ReadDataEndpoints(...)
			pkg, isIdent := f.X.(*ast.Ident)
			if !isIdent || pkg.Name != "argocd" {
				return true
			}
			switch f.Sel.Name {
			case "WaitAddOnsHealthy":
				wait = int(call.Pos())
			case "ReadDataEndpoints":
				read = int(call.Pos())
			}
		case *ast.Ident: // convergeInClusterQueuePasswords(...)
			if f.Name == "convergeInClusterQueuePasswords" {
				converge = int(call.Pos())
			}
		}
		return true
	})

	// EACH SUBJECT IS CHECKED FOR SEPARATELY. A renamed or deleted call would otherwise leave its
	// position at notFound, and `notFound < anything` makes the ordering assertions pass — a guard
	// reporting green over a subject that is no longer there.
	for _, s := range []struct {
		name string
		pos  int
	}{
		{"argocd.WaitAddOnsHealthy", wait},
		{"convergeInClusterQueuePasswords", converge},
		{"argocd.ReadDataEndpoints", read},
	} {
		if s.pos == notFound {
			t.Fatalf("%s is not called in RunDeployV2 — this guard proved nothing about the rest", s.name)
		}
	}

	if converge < wait {
		t.Errorf("convergeInClusterQueuePasswords runs BEFORE argocd.WaitAddOnsHealthy: no broker is " +
			"Ready yet, so it would skip on every deploy and never repair a pre-#3304 queue")
	}
	if converge > read {
		t.Errorf("convergeInClusterQueuePasswords runs AFTER argocd.ReadDataEndpoints: the console " +
			"would be handed the credential the broker does not accept, which is the #3590 defect itself")
	}
}
