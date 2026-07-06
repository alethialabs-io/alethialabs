// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Command elench-verify runs the deterministic verification gate over an OpenTofu
// plan JSON, from a file argument or stdin, and exits non-zero when the verdict
// blocks. It makes the gate usable outside the runner — for local checks, CI, or
// the Phase-0 false-PASS/false-DENY measurement:
//
//	tofu show -json tfplan | elench-verify
//	elench-verify plan.json
//	elench-verify -json plan.json   # machine-readable report on stdout
//
// Exit codes: 0 = pass/warn/not_evaluable, 2 = blocking verdict (fail), 1 = usage
// or parse error.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// run is the testable entry point: it parses flags, reads the plan from the named
// file (or stdin), evaluates it, writes the report, and returns the process exit
// code.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("elench-verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOut := fs.Bool("json", false, "emit the full report as JSON")
	manifests := fs.Bool("manifests", false, "audit Kubernetes manifests (YAML) instead of a tofu plan")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	var data []byte
	var err error
	if fs.NArg() >= 1 {
		data, err = os.ReadFile(fs.Arg(0))
	} else {
		data, err = io.ReadAll(stdin)
	}
	if err != nil {
		fmt.Fprintf(stderr, "elench-verify: read input: %v\n", err)
		return 1
	}

	var rep *verify.Report
	if *manifests {
		rep, err = verify.EvaluateManifests(data)
		if err != nil {
			fmt.Fprintf(stderr, "elench-verify: audit manifests: %v\n", err)
			return 1
		}
	} else {
		// Accepts an Alethia-generated OR a bring-your-own plan (same controls).
		plan, perr := verify.ParseCustomerPlan(data)
		if perr != nil {
			fmt.Fprintf(stderr, "elench-verify: parse plan JSON: %v\n", perr)
			return 1
		}
		rep, err = verify.Evaluate(context.Background(), plan)
		if err != nil {
			fmt.Fprintf(stderr, "elench-verify: evaluate: %v\n", err)
			return 1
		}
	}

	if *jsonOut {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rep); err != nil {
			fmt.Fprintf(stderr, "elench-verify: encode: %v\n", err)
			return 1
		}
	} else {
		writeHuman(stdout, rep)
	}

	if rep.Blocking() {
		return 2
	}
	return 0
}

// writeHuman renders a compact, grayscale text report.
func writeHuman(w io.Writer, rep *verify.Report) {
	fmt.Fprintf(w, "verdict: %s   (%s, catalog %s)\n", rep.Verdict, rep.Provider, rep.CatalogVersion)
	fmt.Fprintf(w, "summary: pass=%d fail=%d warn=%d not_evaluable=%d\n\n",
		rep.Summary.Pass, rep.Summary.Fail, rep.Summary.Warn, rep.Summary.NotEvaluable)
	for _, c := range rep.Controls {
		fmt.Fprintf(w, "[%-4s] %s — %s\n", string(c.Status), c.ID, c.Title)
		for _, f := range c.Findings {
			fmt.Fprintf(w, "         %s: %s\n", f.Address, f.Message)
		}
		if c.Coverage != "" {
			fmt.Fprintf(w, "         coverage: %s\n", c.Coverage)
		}
	}
}
