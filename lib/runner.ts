/**
 * ChunkHound CLI runner.
 *
 * Wraps one-shot `chunkhound` subprocesses via `pi.exec`:
 * - binary resolution (CHUNKHOUND_BIN override)
 * - cancellation (AbortSignal) and per-tool timeouts
 * - heartbeat progress updates for long-running operations
 * - output truncation to protect the LLM context window
 * - "Database not found" detection with an actionable hint
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ChunkhoundResult {
	text: string;
	details: {
		command: string;
		exitCode: number | null;
		durationMs: number;
		truncated: boolean;
	};
}

export interface RunChunkhoundOptions {
	/** CLI arguments, e.g. ["search", "--regex", "foo", "/abs/path"] */
	args: string[];
	/** Human label for progress/error messages, e.g. "search" */
	label: string;
	/** Working directory for the child process (drives .chunkhound/db discovery). */
	cwd: string;
	timeoutMs: number;
	maxOutputChars: number;
	/** Hint appended when chunkhound reports a missing index database. */
	dbMissingHint?: string;
	signal?: AbortSignal;
	onUpdate?: (update: {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}) => void;
}

export type ExecFn = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }>;

export function chunkhoundBin(): string {
	return process.env.CHUNKHOUND_BIN || "chunkhound";
}

/** Read a positive timeout (ms) from an env var, falling back to the default. */
export function envTimeoutMs(name: string, defaultMs: number): number {
	const raw = process.env[name];
	if (!raw) return defaultMs;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

const DB_MISSING_RE = /Database not found/i;

function withDbHint(text: string, hint?: string): string {
	if (!hint || !DB_MISSING_RE.test(text)) return text;
	return `${text}\n\n[chunkhound] Index database is missing — ${hint}.`;
}

/** Truncate long output, keeping the head and appending a visible marker. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const cut = text.slice(0, maxChars);
	// Prefer cutting at a line boundary near the limit for readability.
	const lastNewline = cut.lastIndexOf("\n");
	const head = lastNewline > maxChars * 0.8 ? cut.slice(0, lastNewline) : cut;
	return {
		text: `${head}\n\n[... output truncated at ${maxChars.toLocaleString()} of ${text.length.toLocaleString()} chars — narrow the query, paginate, or raise the env override ...]`,
		truncated: true,
	};
}

export async function runChunkhound(
	exec: ExecFn,
	options: RunChunkhoundOptions,
): Promise<ChunkhoundResult> {
	const bin = chunkhoundBin();
	const command = `${bin} ${options.args.join(" ")}`;
	const started = Date.now();

	if (options.signal?.aborted) {
		throw new Error(`chunkhound ${options.label} cancelled before start`);
	}

	options.onUpdate?.({
		content: [{ type: "text", text: `ChunkHound ${options.label} started…` }],
		details: {},
	});

	// Heartbeat so long ops (research can take minutes) show liveness.
	const heartbeat = setInterval(() => {
		const elapsed = Math.round((Date.now() - started) / 1000);
		options.onUpdate?.({
			content: [
				{ type: "text", text: `ChunkHound ${options.label} still running… ${elapsed}s elapsed` },
			],
			details: {},
		});
	}, 15_000);

	try {
		const result = await exec(bin, options.args, {
			cwd: options.cwd,
			signal: options.signal,
			timeout: options.timeoutMs,
		});

		if (options.signal?.aborted) {
			return {
				text: `ChunkHound ${options.label} cancelled.`,
				details: { command, exitCode: null, durationMs: Date.now() - started, truncated: false },
			};
		}

		if (result.killed) {
			throw new Error(
				`chunkhound ${options.label} was killed (timeout after ${Math.round(options.timeoutMs / 1000)}s?). ` +
					`Raise the CHUNKHOUND_*_TIMEOUT_MS env var or narrow the request.`,
			);
		}

		if (result.code !== 0) {
			const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
			throw new Error(
				withDbHint(
					`chunkhound ${options.label} exited with code ${result.code}:\n${tail}`,
					options.dbMissingHint,
				),
			);
		}

		const out = (result.stdout || "").trim() || (result.stderr || "").trim() || "(no output)";
		const { text, truncated } = truncate(out, options.maxOutputChars);
		return {
			text: withDbHint(text, options.dbMissingHint),
			details: {
				command,
				exitCode: result.code,
				durationMs: Date.now() - started,
				truncated,
			},
		};
	} finally {
		clearInterval(heartbeat);
	}
}

/**
 * Fast PATH existence check (no spawn — Python CLIs can take ~1s to start).
 * Gates registration so machines without chunkhound see no phantom tools.
 */
export function binaryExists(): boolean {
	const bin = chunkhoundBin();
	if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
	const pathEnv = process.env.PATH || "";
	const isWin = process.platform === "win32";
	const exts = isWin ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const dir of pathEnv.split(isWin ? ";" : ":")) {
		if (!dir) continue;
		for (const ext of exts) {
			if (existsSync(join(dir, bin + ext))) return true;
		}
	}
	return false;
}

/** Strip a leading "@" (some models prefix paths) and resolve against the base dir. */
export function resolvePathArg(path: string | undefined, baseDir: string): string | undefined {
	if (!path) return undefined;
	const stripped = path.replace(/^@/, "");
	return stripped ? resolve(stripped, baseDir) : undefined;
}
