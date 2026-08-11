// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// t2budget prints the T2 timeout ladder for the environment it is run in, so
// .github/workflows/e2e-nightly.yml can DERIVE its `timeout-minutes` and `go test -timeout`
// instead of restating numbers that drift from the harness.
//
// They did drift. The workflow hard-coded a 75m step cap beside a comment asserting a 40m ctx —
// which is hetzner's. Every managed cloud has a 50m deploy wait, and the workflow itself turns the
// soak on by default (`vars.E2E_SOAK || '10m'`), so a managed floor leg really wants a 90m ctx. The
// step therefore killed the process before the ctx could cancel, which loses the named scenario
// failure AND skips the in-process t.Cleanup teardown, leaking the cluster to the sweeper. The
// go-timeout was 80m against that same 75m step, so go's goroutine dump was unreachable too.
//
// Output is `key=value` lines for $GITHUB_OUTPUT, plus a human line on stderr:
//
//	ctx_minutes=90
//	go_timeout=95m
//	step_minutes=100
//	job_minutes=115
//
// It also FAILS (exit 1) when the job cap it is told about cannot contain the ladder, so a
// mis-ordered cap is caught about a minute into the run rather than by a mid-scenario kill.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/test/e2e"
)

func main() {
	provider := flag.String("provider", "", "cloud to compute the ladder for (required)")
	env := flag.String("env", "budget", "environment slug; only the fabric-demo term reads it")
	stepCap := flag.Int("step-cap-minutes", 0, "the step's timeout-minutes; verified against the ladder when > 0")
	jobCap := flag.Int("job-cap-minutes", 0, "the job's timeout-minutes; verified against the ladder when > 0")
	flag.Parse()

	if *provider == "" {
		fmt.Fprintln(os.Stderr, "t2budget: -provider is required")
		os.Exit(2)
	}

	b, err := e2e.ResolveT2Budget(*provider, *env)
	if err != nil {
		fmt.Fprintf(os.Stderr, "t2budget: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "t2budget — %s\n", b.Describe())
	fmt.Printf("ctx_minutes=%d\n", int(b.Ctx.Minutes()))
	fmt.Printf("go_timeout=%dm\n", int(b.GoTimeout.Minutes()))
	fmt.Printf("step_minutes=%d\n", int(b.Step.Minutes()))
	fmt.Printf("job_minutes=%d\n", int(b.Job.Minutes()))

	// The step and job caps are the two rungs the workflow cannot derive from this program: both
	// `timeout-minutes` values are evaluated before the step's `run:` executes. So they stay
	// expressions over `vars`, and are VERIFIED here instead. That is what keeps the ladder whole —
	// and it costs a minute, not a scenario.
	//
	// A failure here is deliberately a red. The alternative is what used to happen: the run proceeds
	// with a cap it cannot fit inside and gets killed mid-scenario, which loses the named failure and
	// skips the in-process teardown. Failing at the top of the step is strictly cheaper.
	fail := func(rung string, have, need int) {
		fmt.Fprintf(os.Stderr,
			"t2budget: the %s timeout-minutes is %d but this scenario set needs %d — the ladder is\n"+
				"  %s\n"+
				"Raise that cap in .github/workflows/e2e-nightly.yml, or turn a scenario off.\n"+
				"ALETHIA_E2E_SOAK=off is the cheapest and frees 25m; note that enabling the placement\n"+
				"scenarios (NAMESPACE_TENANT, VCLUSTER) alongside FABRIC_DEMO stacks their budgets into\n"+
				"one ctx, and the fabric demo already places two namespaces and a vcluster itself.\n",
			rung, have, need, b.Describe())
		os.Exit(1)
	}
	if *stepCap > 0 && *stepCap < int(b.Step.Minutes()) {
		fail("step's", *stepCap, int(b.Step.Minutes()))
	}
	if *jobCap > 0 && *jobCap < int(b.Job.Minutes()) {
		fail("job's", *jobCap, int(b.Job.Minutes()))
	}
}
