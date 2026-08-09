// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Additional coverage for the container boundary's argv construction and the parent→child
// projection: the flag-OMISSION branches (a zero pids limit / empty memory limit / no
// configured network), the precedence between an explicit no-egress stage and a configured
// egress net, the malformed parent-env entries Go's os.Environ can actually contain, and
// the byte-level round trip of the serialized stage through the mounted workdir.

// flagValues returns every value that follows an occurrence of flag in args.
func flagValues(args []string, flag string) []string {
	var out []string
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag {
			out = append(out, args[i+1])
		}
	}
	return out
}

// TestBuildArgs_LimitAndNetworkSelection pins the branches where buildArgs OMITS a flag: a
// non-positive pids limit and an empty memory limit emit nothing (rather than "--pids-limit 0"
// or an empty "--memory", both of which a runtime rejects), and a stage with neither NoEgress
// nor a configured network gets no --network at all (the runtime default). It also pins the
// precedence: an explicit no-egress stage overrides a configured egress net.
func TestBuildArgs_LimitAndNetworkSelection(t *testing.T) {
	workDir := t.TempDir()
	childEnv := buildChildEnv([]string{"PATH=/usr/bin"}, workDir)

	cases := []struct {
		name        string
		container   Container
		noEgress    bool
		wantPids    []string
		wantMemory  []string
		wantNetwork []string
	}{
		{
			name:      "zero pids limit and empty memory limit emit no flag",
			container: Container{Runtime: "docker", Image: "img", PidsLimit: 0, MemLimit: ""},
		},
		{
			name:       "configured limits are emitted",
			container:  Container{Runtime: "docker", Image: "img", PidsLimit: 512, MemLimit: "2g"},
			wantPids:   []string{"512"},
			wantMemory: []string{"2g"},
		},
		{
			name:      "negative pids limit is treated as unset",
			container: Container{Runtime: "docker", Image: "img", PidsLimit: -1},
		},
		{
			name:        "configured egress net is used when the stage permits egress",
			container:   Container{Runtime: "docker", Image: "img", Network: "alethia-egress"},
			wantNetwork: []string{"alethia-egress"},
		},
		{
			name:        "an explicit no-egress stage overrides the configured net",
			container:   Container{Runtime: "docker", Image: "img", Network: "alethia-egress"},
			noEgress:    true,
			wantNetwork: []string{"none"},
		},
		{
			name:      "neither no-egress nor a configured net leaves --network off entirely",
			container: Container{Runtime: "docker", Image: "img"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			args := tc.container.buildArgs(Spec{Kind: "deploy", JobID: "job-1", WorkDir: workDir, NoEgress: tc.noEgress}, childEnv)

			if got := flagValues(args, "--pids-limit"); !reflect.DeepEqual(got, tc.wantPids) {
				t.Errorf("--pids-limit = %v, want %v (argv %v)", got, tc.wantPids, args)
			}
			if got := flagValues(args, "--memory"); !reflect.DeepEqual(got, tc.wantMemory) {
				t.Errorf("--memory = %v, want %v (argv %v)", got, tc.wantMemory, args)
			}
			if got := flagValues(args, "--network"); !reflect.DeepEqual(got, tc.wantNetwork) {
				t.Errorf("--network = %v, want %v (argv %v)", got, tc.wantNetwork, args)
			}
			// Invariants that hold for every shape: the image closes the argv and the
			// per-job workdir is the only writable bind.
			if args[len(args)-1] != tc.container.Image {
				t.Errorf("last argv token = %q, want the image %q", args[len(args)-1], tc.container.Image)
			}
			if got := flagValues(args, "-v"); len(got) != 1 || got[0] != workDir+":"+workDir+":rw" {
				t.Errorf("binds = %v, want exactly the rw workdir mount", got)
			}
		})
	}
}

// TestBuildChildEnv_MalformedParentEntries pins that the parent→child projection tolerates
// the entries a real os.Environ can hold — Go blanks a duplicate key to "" rather than
// removing it, and a value can legitimately contain '=' — without dropping a legitimate
// key or leaking a blanked one.
func TestBuildChildEnv_MalformedParentEntries(t *testing.T) {
	workDir := "/work/job-1"
	parent := []string{
		"",                       // a duplicate key blanked by syscall.copyenv
		"NO_EQUALS_SIGN",         // no separator at all
		"=leading-equals",        // empty key
		"PATH=/usr/bin",          // legitimate, must survive
		"AWS_PROFILE=a=b",        // '=' inside the value must survive intact
		"PATH_EXTRA=/should/not", // must NOT be read as PATH
	}

	got := buildChildEnv(parent, workDir)

	env := map[string]string{}
	for _, kv := range got {
		if kv == "" {
			t.Fatalf("buildChildEnv emitted an empty entry: %q", got)
		}
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			t.Fatalf("buildChildEnv emitted a malformed entry %q", kv)
		}
		env[kv[:i]] = kv[i+1:]
	}
	if env["PATH"] != "/usr/bin" {
		t.Errorf("PATH = %q, want /usr/bin (a prefix-sharing key must not shadow it)", env["PATH"])
	}
	if env["AWS_PROFILE"] != "a=b" {
		t.Errorf("AWS_PROFILE = %q, want %q", env["AWS_PROFILE"], "a=b")
	}
	if _, ok := env["PATH_EXTRA"]; ok {
		t.Error("PATH_EXTRA is not allowlisted and must not cross")
	}
	if _, ok := env["NO_EQUALS_SIGN"]; ok {
		t.Error("a separator-less parent entry must not cross")
	}
	if err := assertNoSecrets(got); err != nil {
		t.Errorf("the projection of a malformed parent env must still pass the guard: %v", err)
	}
}

// TestBuildArgs_DeterministicAcrossParentEnvOrder pins that the emitted argv does not depend
// on the iteration order of the allowlist map or the order of the parent environment — the
// child env is sorted before it is turned into --env flags, so two runs of the same job
// produce byte-identical argv (a prerequisite for reproducible, reviewable sandbox invocations).
func TestBuildArgs_DeterministicAcrossParentEnvOrder(t *testing.T) {
	workDir := t.TempDir()
	c := Container{Runtime: "docker", Image: "img", PidsLimit: 512, MemLimit: "2g"}
	spec := Spec{Kind: "deploy", JobID: "job-det", WorkDir: workDir}

	forward := []string{"PATH=/usr/bin", "AWS_PROFILE=alethia-customer", "AWS_REGION=eu-central-1", "LANG=C.UTF-8", "TZ=UTC"}
	reversed := make([]string, len(forward))
	for i, kv := range forward {
		reversed[len(forward)-1-i] = kv
	}

	first := c.buildArgs(spec, buildChildEnv(forward, workDir))
	for i := 0; i < 8; i++ {
		src := forward
		if i%2 == 1 {
			src = reversed
		}
		if got := c.buildArgs(spec, buildChildEnv(src, workDir)); !reflect.DeepEqual(got, first) {
			t.Fatalf("argv is not deterministic:\n got %v\nwant %v", got, first)
		}
	}
}

// TestContainerRun_StageRoundTripsThroughWorkDir pins that the bytes Run leaves in the
// mounted workdir decode back to exactly the Spec.Stage the caller supplied — the child
// reconstructs its work from this file alone, so a lossy write would silently change the
// work that runs.
func TestContainerRun_StageRoundTripsThroughWorkDir(t *testing.T) {
	cases := []struct {
		name  string
		stage Stage
	}{
		{"deploy payload", Stage{Kind: StageDeploy, Payload: json.RawMessage(`{"provider":"aws","dry_run":false}`)}},
		{"chart scan payload", Stage{Kind: StageChartScan, Payload: json.RawMessage(`{"chart_dir":"/w/chart","values":{"a":1}}`)}},
		{"iac scan payload", Stage{Kind: StageIacScan, Payload: json.RawMessage(`{"module_dir":"/w/mod","commit_sha":"deadbeef"}`)}},
		{"empty payload", Stage{Kind: StageDrift, Payload: json.RawMessage(`{}`)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			workDir := t.TempDir()
			c := Container{Runtime: stubRuntime(t, `{"error":""}`, 0), Image: "img", Operator: "self"}
			stage := tc.stage
			if err := c.Run(context.Background(), Spec{
				Kind: string(stage.Kind), JobID: "job-rt", WorkDir: workDir, Stage: &stage,
			}, nil); err != nil {
				t.Fatalf("Run: %v", err)
			}

			raw, err := os.ReadFile(filepath.Join(workDir, "stage.json"))
			if err != nil {
				t.Fatalf("read stage.json: %v", err)
			}
			var back Stage
			if err := json.Unmarshal(raw, &back); err != nil {
				t.Fatalf("stage.json does not decode as a Stage: %v (%s)", err, raw)
			}
			if back.Kind != stage.Kind {
				t.Errorf("kind = %q, want %q", back.Kind, stage.Kind)
			}
			var wantPayload, gotPayload interface{}
			if err := json.Unmarshal(stage.Payload, &wantPayload); err != nil {
				t.Fatalf("fixture payload: %v", err)
			}
			if err := json.Unmarshal(back.Payload, &gotPayload); err != nil {
				t.Fatalf("round-tripped payload: %v", err)
			}
			if !reflect.DeepEqual(gotPayload, wantPayload) {
				t.Errorf("payload = %v, want %v", gotPayload, wantPayload)
			}
		})
	}
}
