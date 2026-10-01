// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// #5151: in container mode the per-job secrets used to be read from the RUNNER's own env,
// where nothing ever set them — so the child ran with no git token, no add-on secrets, no
// talosconfig and no state token. They now cross on Spec.Secrets, a per-job channel. These
// tests pin the channel: every allowlisted key reaches the child, by value on the runtime
// CLI's cmd.Env and by NAME only on the argv (#2041); any other key is dropped; the runner's
// env is not a source; and two jobs run at once never see each other's secrets.

// allStageSecrets is one job's full set of per-job secrets, each value unique to `tag` so a
// cross-job leak is attributable.
func allStageSecrets(tag string) map[string]string {
	return map[string]string{
		EnvStateToken:   "STATE-" + tag,
		EnvGitToken:     "GIT-" + tag,
		EnvGitTokens:    `{"https://git.example/` + tag + `":"GITMAP-` + tag + `"}`,
		EnvAddonSecrets: `{"a":{"k":"ADDON-` + tag + `"}}`,
		EnvTalosConfig:  "TALOS-" + tag,
	}
}

// TestSpecSecrets_EveryAllowlistedKeyReachesChildEnvNeverArgv runs the backend's env builder,
// argv builder and runtime-env builder over a Spec carrying every stage secret: each key must
// be in the child env with its value, on the argv by name only, and on the runtime's cmd.Env.
func TestSpecSecrets_EveryAllowlistedKeyReachesChildEnvNeverArgv(t *testing.T) {
	workDir := t.TempDir()
	secrets := allStageSecrets("job-a")
	spec := Spec{Kind: "deploy", JobID: "job-a", WorkDir: workDir, Secrets: secrets}

	childEnv := buildChildEnv([]string{"PATH=/usr/bin"}, workDir, spec.Secrets)
	if err := assertNoSecrets(childEnv); err != nil {
		t.Fatalf("assertNoSecrets on the child env: %v", err)
	}
	args := Container{Runtime: "docker", Image: "img"}.buildArgs(spec, childEnv)
	joined := strings.Join(args, "\x00")
	rtEnv := runtimeEnv([]string{"PATH=/usr/bin"}, childEnv)

	if len(secrets) != len(stageSecretEnvKeys) {
		t.Fatalf("the fixture covers %d keys but the allowlist has %d", len(secrets), len(stageSecretEnvKeys))
	}
	for k, v := range secrets {
		if !envHas(childEnv, k+"="+v) {
			t.Errorf("child env is missing %s from Spec.Secrets", k)
		}
		if !argvHasEnvName(args, k) {
			t.Errorf("%s is not passed by name (--env %s): the runtime cannot forward it", k, k)
		}
		if strings.Contains(joined, v) {
			t.Errorf("the value of %s appears on the runtime argv", k)
		}
		if !containsPair(rtEnv, k+"="+v) {
			t.Errorf("the runtime CLI's env is missing %s, so `--env %s` would forward nothing", k, k)
		}
	}
}

// TestSpecSecrets_KeyOutsideAllowlistIsDropped proves Spec.Secrets is not a way to put an
// arbitrary variable into the child: a denylisted runner secret, a cloud token, a toolchain
// override and an unknown stage key are all dropped, and Run warns naming the keys only.
func TestSpecSecrets_KeyOutsideAllowlistIsDropped(t *testing.T) {
	workDir := t.TempDir()
	secrets := map[string]string{
		EnvGitToken:                    "GIT-OK",
		"ALETHIA_RUNNER_TOKEN":         "RUNNER-TOKEN-VALUE",
		"HCLOUD_TOKEN":                 "HCLOUD-VALUE",
		"PATH":                         "/evil/bin",
		"LD_PRELOAD":                   "/evil.so",
		"ALETHIA_STAGE_NOT_A_REAL_KEY": "UNKNOWN-VALUE",
	}
	child := buildChildEnv([]string{"PATH=/usr/bin"}, workDir, secrets)
	if err := assertNoSecrets(child); err != nil {
		t.Fatalf("a dropped key must never reach the guard: %v", err)
	}
	if !envHas(child, EnvGitToken+"=GIT-OK") {
		t.Error("the allowlisted key must still cross")
	}
	for _, v := range []string{"RUNNER-TOKEN-VALUE", "HCLOUD-VALUE", "/evil/bin", "/evil.so", "UNKNOWN-VALUE"} {
		for _, kv := range child {
			if strings.Contains(kv, v) {
				t.Errorf("a key outside the allowlist crossed: %q", kv)
			}
		}
	}
	if !envHas(child, "PATH=/usr/bin") {
		t.Error("a Spec.Secrets PATH must not replace the runner's PATH")
	}

	// Run names the dropped keys, never their values.
	var warned []string
	stub := stubRuntime(t, `{}`, 0)
	err := Container{Runtime: stub, Image: "img", Operator: "self"}.Run(context.Background(), Spec{
		Kind: "deploy", JobID: "j", WorkDir: workDir, Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")},
		Secrets: secrets, Warn: func(s string) { warned = append(warned, s) },
	}, nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	all := strings.Join(warned, "\n")
	for _, k := range []string{"ALETHIA_RUNNER_TOKEN", "HCLOUD_TOKEN", "PATH", "LD_PRELOAD", "ALETHIA_STAGE_NOT_A_REAL_KEY"} {
		if !strings.Contains(all, k) {
			t.Errorf("the warning does not name dropped key %s: %q", k, all)
		}
	}
	for _, v := range []string{"RUNNER-TOKEN-VALUE", "HCLOUD-VALUE", "UNKNOWN-VALUE"} {
		if strings.Contains(all, v) {
			t.Errorf("the warning leaked a dropped value: %q", all)
		}
	}
}

// TestStageSecretKeys_AreAllSecretValued pins that every key the channel carries is one
// buildArgs passes by name — otherwise a new stage secret would ride the argv in plaintext.
func TestStageSecretKeys_AreAllSecretValued(t *testing.T) {
	for k := range stageSecretEnvKeys {
		if !isSecretValueEnvKey(k) {
			t.Errorf("stage secret key %s is not in secretValueEnvKeys: its value would go on the argv", k)
		}
		if isDeniedEnvKey(k) {
			t.Errorf("stage secret key %s is denylisted: assertNoSecrets would refuse every job carrying it", k)
		}
	}
}

// TestRuntimeEnv_RunnerEnvIsNotASecretSource proves a stage-secret value sitting in the
// runner's own env (stale, or set by an in-process stage) reaches neither the child env nor
// the runtime CLI: only this job's Spec.Secrets does.
func TestRuntimeEnv_RunnerEnvIsNotASecretSource(t *testing.T) {
	workDir := t.TempDir()
	parent := []string{
		"PATH=/usr/bin",
		EnvStateToken + "=STALE-STATE",
		EnvGitToken + "=STALE-GIT",
		EnvTalosConfig + "=STALE-TALOS",
	}
	child := buildChildEnv(parent, workDir, map[string]string{EnvStateToken: "FRESH-STATE"})
	rt := runtimeEnv(parent, child)
	for _, env := range [][]string{child, rt} {
		for _, kv := range env {
			if strings.Contains(kv, "STALE-") {
				t.Errorf("the runner's own env leaked a stage secret: %q", kv)
			}
		}
	}
	if !containsPair(rt, EnvStateToken+"=FRESH-STATE") {
		t.Errorf("the runtime env is missing this job's state token: %v", rt)
	}
	if !containsPair(rt, "PATH=/usr/bin") {
		t.Error("runtimeEnv must keep the runner's non-secret env for the runtime CLI")
	}
}

// capturingRuntime is a stub runtime CLI that records its own environment and argv into the
// workdir (runtime.env / runtime.argv), writes result.json, and exits 0.
func capturingRuntime(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "capture-runtime.sh")
	script := "#!/bin/sh\n" +
		"wd=\n" +
		"for a in \"$@\"; do\n" +
		"  case \"$a\" in\n" +
		"    ALETHIA_STAGE_WORKDIR=*) wd=${a#ALETHIA_STAGE_WORKDIR=} ;;\n" +
		"  esac\n" +
		"done\n" +
		"[ -n \"$wd\" ] || exit 90\n" +
		"env > \"$wd/runtime.env\"\n" +
		"printf '%s\\n' \"$@\" > \"$wd/runtime.argv\"\n" +
		"printf '{}' > \"$wd/result.json\"\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write capturing runtime: %v", err)
	}
	return path
}

// TestContainerRun_ConcurrentJobsSeeOnlyTheirOwnSecrets runs several jobs through Run AT ONCE,
// each with its own secrets, and reads back what each job's runtime CLI actually received: every
// job's runtime holds exactly its own values and none of another job's, and no value is on any
// argv. A process-global env (os.Setenv) channel fails this — that is the design it rules out.
func TestContainerRun_ConcurrentJobsSeeOnlyTheirOwnSecrets(t *testing.T) {
	stub := capturingRuntime(t)
	c := Container{Runtime: stub, Image: "img", Operator: "self"}
	const jobs = 6
	dirs := make([]string, jobs)
	for i := range dirs {
		dirs[i] = t.TempDir()
	}

	var wg sync.WaitGroup
	errs := make([]error, jobs)
	for i := 0; i < jobs; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tag := fmt.Sprintf("job%d", i)
			errs[i] = c.Run(context.Background(), Spec{
				Kind: "deploy", JobID: tag, WorkDir: dirs[i],
				Stage:   &Stage{Kind: StageDeploy, Payload: []byte("{}")},
				Secrets: allStageSecrets(tag),
			}, nil)
		}(i)
	}
	wg.Wait()

	for i := 0; i < jobs; i++ {
		if errs[i] != nil {
			t.Fatalf("job %d: Run: %v", i, errs[i])
		}
		env, err := os.ReadFile(filepath.Join(dirs[i], "runtime.env"))
		if err != nil {
			t.Fatalf("job %d: read runtime.env: %v", i, err)
		}
		argv, err := os.ReadFile(filepath.Join(dirs[i], "runtime.argv"))
		if err != nil {
			t.Fatalf("job %d: read runtime.argv: %v", i, err)
		}
		lines := strings.Split(string(env), "\n")
		for k, v := range allStageSecrets(fmt.Sprintf("job%d", i)) {
			if !containsPair(lines, k+"="+v) {
				t.Errorf("job %d: its runtime did not receive its own %s", i, k)
			}
			if strings.Contains(string(argv), v) {
				t.Errorf("job %d: the value of %s is on the runtime argv", i, k)
			}
		}
		for j := 0; j < jobs; j++ {
			if j == i {
				continue
			}
			for k, v := range allStageSecrets(fmt.Sprintf("job%d", j)) {
				if strings.Contains(string(env), v) || strings.Contains(string(argv), v) {
					t.Errorf("job %d received job %d's %s", i, j, k)
				}
			}
		}
	}

	// And after them, a job carrying only a state token inherits nothing they left behind —
	// the deterministic half: interleaving can hide a shared channel, a leftover cannot.
	last := t.TempDir()
	if err := c.Run(context.Background(), Spec{
		Kind: "destroy", JobID: "after", WorkDir: last,
		Stage:   &Stage{Kind: StageDestroy, Payload: []byte("{}")},
		Secrets: map[string]string{EnvStateToken: "STATE-after"},
	}, nil); err != nil {
		t.Fatalf("follow-up job: Run: %v", err)
	}
	env, err := os.ReadFile(filepath.Join(last, "runtime.env"))
	if err != nil {
		t.Fatalf("follow-up job: read runtime.env: %v", err)
	}
	for j := 0; j < jobs; j++ {
		for k, v := range allStageSecrets(fmt.Sprintf("job%d", j)) {
			if strings.Contains(string(env), v) {
				t.Errorf("a later job inherited job %d's %s", j, k)
			}
		}
	}
}
