// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal WebGL2 helpers for the fullscreen-shader hero. No scene graph, no
 * geometry buffers — the vertex shader emits a fullscreen triangle from
 * gl_VertexID, so a program plus an empty VAO is all that's needed.
 */

/** Compiles one shader stage; returns null on failure (caller falls back). */
function compileShader(
	gl: WebGL2RenderingContext,
	type: number,
	src: string,
): WebGLShader | null {
	const shader = gl.createShader(type);
	if (!shader) return null;
	gl.shaderSource(shader, src);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

/**
 * Compiles + links a program from vertex and fragment source. Returns null if
 * either stage fails to compile or the program fails to link — the hero then
 * degrades to its CSS blueprint-grid fallback.
 */
export function buildProgram(
	gl: WebGL2RenderingContext,
	vertSrc: string,
	fragSrc: string,
): WebGLProgram | null {
	const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
	if (!vs || !fs) return null;
	const program = gl.createProgram();
	if (!program) return null;
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	// Shaders are no longer needed once linked into the program.
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		gl.deleteProgram(program);
		return null;
	}
	return program;
}
