// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "The Focusing Field" — the generative hero shader.
 *
 * A blueprint/topographic contour field built from domain-warped fbm noise.
 * At the edges the iso-contours drift as faint, incoherent blueprint lines
 * (concealment); toward the center a radial phase term compresses them into
 * concentric rings that resolve onto the [·] mark — aletheia, truth brought
 * into focus. Strictly monochrome by construction: the only outputs are a
 * scalar ink luminance (flipped by theme) and a coverage alpha, composited
 * over the page's own --background. There is no path for chroma, and the CTA
 * blue is never referenced here.
 */

/** Fullscreen triangle emitted from gl_VertexID — no vertex buffer needed. */
export const VERT_SRC = `#version 300 es
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Builds the fragment shader. `octaves` trades fidelity for cost — 5 on
 * capable hardware, 3 on mobile / low-core devices.
 */
export function buildFragSrc(octaves: number): string {
	return `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;       // seconds; frozen for the reduced-motion still frame
uniform float uThemeDark;  // 0.0 light, 1.0 dark
uniform vec2  uPointer;    // smoothed, -1..1, (0,0) at rest
uniform float uReveal;     // 0..1 intro fade

out vec4 fragColor;

#define OCTAVES ${octaves}

float hash(vec2 p) {
	p = fract(p * vec2(123.34, 345.45));
	p += dot(p, p + 34.345);
	return fract(p.x * p.y);
}

float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = hash(i), b = hash(i + vec2(1.0, 0.0));
	float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
	float s = 0.0, a = 0.5;
	mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
	for (int i = 0; i < OCTAVES; i++) {
		s += a * vnoise(p);
		p = m * p;
		a *= 0.5;
	}
	return s;
}

void main() {
	vec2 res = max(uResolution, vec2(1.0));
	// aspect-correct, y-up, centered at the focal point
	vec2 uv = (gl_FragCoord.xy - 0.5 * res) / res.y;

	vec2 focus = uPointer * 0.06;
	vec2 p = uv - focus;
	float r = length(p);

	float t = uTime * 0.04;

	// domain warp — a slow topographic drift
	vec2 q = vec2(
		fbm(p * 2.0 + vec2(0.0, t)),
		fbm(p * 2.0 + vec2(4.3, -t) + 2.1)
	);
	float field = fbm(p * 2.4 + q * 1.2);

	// near the center, a radial phase turns the contours into concentric
	// rings converging on the mark; far out it stays incoherent blueprint noise
	float focusGain = exp(-r * r * 6.0);
	float phase = field * 3.2 + r * 13.0 - focusGain * 6.0;

	// iso-contour blueprint lines, screen-space anti-aliased via fwidth
	float band = abs(fract(phase) - 0.5);
	float aa = fwidth(phase) * 1.2 + 1e-4;
	float line = 1.0 - smoothstep(0.5 - aa, 0.5 + aa, band);
	// dissolve toward the edges, like .ah-grid-bg's radial mask
	line *= smoothstep(1.05, 0.32, r);

	// the [·] mark resolving out of the rings (proportions mirror the SVG Mark)
	float px = fwidth(r) + 1e-4;
	vec2 ap = abs(p);
	float bx = 0.060;        // bracket bar x-offset
	float halfH = 0.063;     // bracket half-height
	float serif = 0.028;     // inner serif length
	float th = 0.0026;       // stroke half-thickness
	float barV = (1.0 - smoothstep(th, th + px * 1.5, abs(ap.x - bx)))
		* (1.0 - step(halfH, ap.y));
	float barH = (1.0 - smoothstep(th, th + px * 1.5, abs(ap.y - halfH)))
		* step(bx - serif, ap.x) * (1.0 - step(bx + th, ap.x));
	float dotm = 1.0 - smoothstep(0.017, 0.017 + px * 1.5, r);
	float mark = clamp(barV + barH + dotm, 0.0, 1.0);

	// faint field + crisp mark
	float ink = clamp(line * 0.4 + mark * 0.92, 0.0, 1.0);

	// calm the zone under the headline (upper center) so copy stays legible
	float calm = smoothstep(0.0, 0.42, distance(uv, vec2(0.0, 0.16)));
	ink *= mix(0.5, 1.0, calm);

	ink *= uReveal;

	// theme-aware ink luminance; the field itself is the page --background
	// showing through the transparent canvas
	float inkLum = mix(0.12, 0.94, uThemeDark);
	fragColor = vec4(vec3(inkLum), ink);
}`;
}
