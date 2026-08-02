// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package selfimage resolves the runner's own container image reference.
//
// Several renders need to name the runner image because they schedule the runner binary as
// something else's sidecar or Job — the keyless DB auth proxy and its bootstrap Job, the
// cross-account registry-token refresher, the keyless Helm-ECR refresher. Each of those fails
// closed when it does not have a ref, which is correct: emitting a workload with a blank or
// guessed image would fail later, further from the cause, on the customer's cluster.
//
// It used to be read straight from ALETHIA_RUNNER_IMAGE at four call sites, and nothing that
// shipped ever set it — so those renders were silently refusing on every deployed runner while
// their deploys reported success (#1787). A value five features fail closed on is not a setting an
// operator should have to know about, so the ref is now BAKED INTO THE IMAGE at build time and the
// environment variable becomes an override rather than a requirement.
package selfimage

import (
	"os"
	"strings"
)

// EnvOverride is the operator-facing override. It exists for the cases the build cannot know
// about — a private mirror, an air-gapped registry, a digest pin — not for normal operation.
const EnvOverride = "ALETHIA_RUNNER_IMAGE"

// EnvBaked is written into the image by the Dockerfile from the SELF_IMAGE build arg. It is
// deliberately absent from locally built images: docker-compose builds the runner from source with
// no published tag, so there is no honest value to bake and a guessed one would name a different
// image than the one running.
const EnvBaked = "ALETHIA_RUNNER_SELF_IMAGE"

// Ref returns the runner's own image reference, or "" when it is not derivable.
//
// An empty result is a real answer, not an error: a locally built or natively run runner has no
// published ref and never will. Callers fail closed on it, which is why this does not substitute a
// plausible-looking default.
func Ref() string {
	if v := strings.TrimSpace(os.Getenv(EnvOverride)); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv(EnvBaked))
}
