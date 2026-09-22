// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// gcpzone picks the ZONE the nightly's gcp leg provisions in, from a fallback list, so a stockout
// in one zone does not red the leg every night.
//
// It exists for the same reason cmd/t2budget does: the decision belongs to the harness, which can
// be unit-tested offline, and the workflow should CALL it rather than restate it in shell that
// nothing checks. The whole argument — why a fallback list, why the existing preflight cannot see a
// stockout, and why every candidate must be a zone and never a region — is on test/e2e/t2_gcp_zone.go.
//
// Output is `key=value` lines on stdout for $GITHUB_ENV, plus a human line on stderr:
//
//	E2E_REGION=europe-west3-b
//	ALETHIA_E2E_REGION=europe-west3-b
//
// Both names are written because the workflow's own compute step writes both: E2E_REGION is what
// the later steps and the sweeper interpolate, ALETHIA_E2E_REGION is what the T2 harness reads.
// Emitting one and not the other would leave the cleanup sweeping a zone the run did not use.
//
// It exits non-zero only on a real refusal — a malformed list, or a machine type no candidate zone
// sells. A probe that could not answer is NOT a refusal: it prints the first candidate and says so.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/test/e2e"
)

func main() {
	zoneList := flag.String("zones", "", "candidate zones, comma- or space-separated (default: the harness's DefaultGCPZones)")
	pinned := flag.String("pinned", "", "an operator-supplied zone; when set, it is used verbatim and nothing is chosen")
	clusterJSON := flag.String("cluster-json", "", "the run's cluster shape; instance_types[0] is the machine type to look for")
	machineType := flag.String("machine-type", "", "the machine type to look for, if not taken from -cluster-json")
	timeout := flag.Duration("timeout", 2*time.Minute, "bound on the whole selection, across every candidate probe")
	flag.Parse()

	candidates := e2e.DefaultGCPZones
	if strings.TrimSpace(*zoneList) != "" {
		parsed, err := e2e.ParseGCPZones(*zoneList)
		if err != nil {
			fmt.Fprintf(os.Stderr, "gcpzone: %v\n", err)
			os.Exit(1)
		}
		candidates = parsed
	}

	// A pinned zone short-circuits everything, and is validated the same way the list is — an
	// operator who dispatches with a region typed into the `region` input is making the exact cost
	// mistake #3566 fixed, and should be told so before the apply and not after the bill.
	if z := strings.TrimSpace(*pinned); z != "" {
		one, err := e2e.ParseGCPZones(z)
		if err != nil {
			fmt.Fprintf(os.Stderr, "gcpzone: %v\n", err)
			os.Exit(1)
		}
		emit(e2e.GCPZoneChoice{
			Zone:       one[0],
			Verdict:    e2e.GCPZonePinned,
			Considered: one,
			Detail: fmt.Sprintf("%s was named explicitly, so no zone was chosen and no candidate was probed; "+
				"the run's own pre-spend capacity preflight still checks it", one[0]),
		})
		return
	}

	want := strings.TrimSpace(*machineType)
	if want == "" {
		want = machineTypeFromClusterJSON(*clusterJSON)
	}

	offset := e2e.GCPZoneRotationOffset(envUint("GITHUB_RUN_ID"), envUint("GITHUB_RUN_ATTEMPT"), len(candidates))
	rotated := e2e.RotateGCPZones(candidates, offset)

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	choice, err := e2e.ChooseGCPZone(ctx, rotated, want, e2e.GCPMachineTypeNames)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gcpzone: %v\n", err)
		// ::error:: so it lands on the run's summary rather than only in the step log — this is a
		// pre-spend refusal and the reader needs it without opening the job.
		fmt.Fprintf(os.Stderr, "::error title=gcp zone selection refused::%v\n", err)
		os.Exit(1)
	}
	emit(choice)
}

// emit writes the $GITHUB_ENV lines and the human line.
//
// The notice carries the VERDICT, not just the zone. A run whose zone was picked UNVERIFIED and a
// run whose zone was CONFIRMED must not read the same in the log — that collapse is the defect the
// preflight's three verdicts exist to prevent, and repeating the zone alone would reintroduce it
// one layer up.
func emit(c e2e.GCPZoneChoice) {
	fmt.Fprintf(os.Stderr, "gcpzone [%s] — %s\n", c.Verdict, c.Detail)
	fmt.Fprintf(os.Stderr, "::notice title=gcp zone for this run::%s [%s] — %s\n", c.Zone, c.Verdict, c.Detail)
	fmt.Printf("E2E_REGION=%s\n", c.Zone)
	fmt.Printf("ALETHIA_E2E_REGION=%s\n", c.Zone)
}

// machineTypeFromClusterJSON reads instance_types[0] out of the run's shape.
//
// Every failure here returns "", which ChooseGCPZone treats as "nothing to check" rather than as an
// error: the shape is resolved by an earlier workflow step that has its own guards, and a run must
// not be refused a zone because this program could not parse something. The per-run preflight
// resolves the same type from the snapshot and is the one that fails hard.
func machineTypeFromClusterJSON(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	var shape struct {
		InstanceTypes []string `json:"instance_types"`
	}
	if err := json.Unmarshal([]byte(raw), &shape); err != nil {
		fmt.Fprintf(os.Stderr, "gcpzone: -cluster-json is not decodable (%v) — no machine type resolved\n", err)
		return ""
	}
	if len(shape.InstanceTypes) == 0 {
		return ""
	}
	return strings.TrimSpace(shape.InstanceTypes[0])
}

// envUint reads a non-negative integer from the environment, or 0.
func envUint(key string) uint64 {
	n, err := strconv.ParseUint(strings.TrimSpace(os.Getenv(key)), 10, 64)
	if err != nil {
		return 0
	}
	return n
}
