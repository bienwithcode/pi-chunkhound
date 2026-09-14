/**
 * Unit tests for lib/runner.ts — pure helpers + runChunkhound with a fake ExecFn.
 * Run: npm test (node --test test/)
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	binaryExists,
	chunkhoundBin,
	envTimeoutMs,
	resolvePathArg,
	runChunkhound,
	truncate,
	type ExecFn,
} from "../lib/runner.ts";

type ExecResult = { stdout: string; stderr: string; code: number | null; killed: boolean };

/** ExecFn fake that records calls and returns a canned (or computed) result. */
function fakeExec(
	result: ExecResult | ((command: string, args: string[]) => ExecResult),
): ExecFn & { calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> } {
	const calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
	const fn: ExecFn = async (command, args, options) => {
		calls.push({ command, args, options: options as Record<string, unknown> | undefined });
		return typeof result === "function" ? result(command, args) : result;
	};
	return Object.assign(fn, { calls });
}

const ok = (stdout = "hello"): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });

/** Snapshot and restore process.env keys around each test. */
const ENV_KEYS = ["CHUNKHOUND_BIN", "PATH", "CHUNKHOUND_TEST_TIMEOUT_MS"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
	envSnapshot = {};
	for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (envSnapshot[key] === undefined) delete process.env[key];
		else process.env[key] = envSnapshot[key];
	}
});

describe("envTimeoutMs", () => {
	test("returns default when env is unset", () => {
		delete process.env.CHUNKHOUND_TEST_TIMEOUT_MS;
		assert.equal(envTimeoutMs("CHUNKHOUND_TEST_TIMEOUT_MS", 5000), 5000);
	});

	test("uses a valid positive override", () => {
		process.env.CHUNKHOUND_TEST_TIMEOUT_MS = "9000";
		assert.equal(envTimeoutMs("CHUNKHOUND_TEST_TIMEOUT_MS", 5000), 9000);
	});

	test("falls back to default on garbage, zero, or negative values", () => {
		for (const bad of ["abc", "0", "-10", ""]) {
			process.env.CHUNKHOUND_TEST_TIMEOUT_MS = bad;
			assert.equal(envTimeoutMs("CHUNKHOUND_TEST_TIMEOUT_MS", 5000), 5000, `value: ${bad}`);
		}
	});
});

describe("chunkhoundBin", () => {
	test("defaults to chunkhound", () => {
		delete process.env.CHUNKHOUND_BIN;
		assert.equal(chunkhoundBin(), "chunkhound");
	});

	test("honors CHUNKHOUND_BIN override", () => {
		process.env.CHUNKHOUND_BIN = "/opt/bin/ch";
		assert.equal(chunkhoundBin(), "/opt/bin/ch");
	});
});

describe("truncate", () => {
	test("keeps short text unchanged", () => {
		const r = truncate("short", 100);
		assert.equal(r.text, "short");
		assert.equal(r.truncated, false);
	});

	test("truncates long text with a visible marker and counts", () => {
		const text = "x".repeat(300);
		const r = truncate(text, 100);
		assert.equal(r.truncated, true);
		assert.ok(r.text.startsWith("x".repeat(100)));
		assert.ok(r.text.includes("output truncated at 100"));
		assert.ok(r.text.includes("of 300 chars"));
	});

	test("prefers cutting at a line boundary in the last 20%", () => {
		// Newline at index 9000 (within last 20% of a 10000-char cap).
		const text = "a".repeat(9000) + "\n" + "b".repeat(2000);
		const r = truncate(text, 10000);
		assert.ok(r.text.startsWith("a".repeat(9000) + "\n\n[..."), "should cut right after the newline");
	});

	test("hard-cuts when the only newline is early", () => {
		const text = "a".repeat(100) + "\n" + "b".repeat(20000);
		const r = truncate(text, 10000);
		assert.equal(r.truncated, true);
		// Cut is the raw 10000-char slice (line boundary too early to prefer).
		assert.ok(r.text.startsWith("a".repeat(100) + "\n" + "b".repeat(9899)));
	});
});

describe("resolvePathArg", () => {
	test("returns undefined for undefined/empty path", () => {
		assert.equal(resolvePathArg(undefined, "/base"), undefined);
		assert.equal(resolvePathArg("", "/base"), undefined);
	});

	test("strips a leading @ (models sometimes prefix paths)", () => {
		assert.equal(resolvePathArg("@src/app", "/base"), join("/base", "src/app"));
	});

	test("resolves relative paths against baseDir", () => {
		assert.equal(resolvePathArg("lib/tools", "/base"), join("/base", "lib/tools"));
	});

	test("keeps absolute paths absolute", () => {
		assert.equal(resolvePathArg("/abs/path", "/base"), "/abs/path");
	});
});

describe("binaryExists", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-ch-runner-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("true for an existing absolute path", () => {
		const file = join(dir, "ch-binary");
		writeFileSync(file, "#!/bin/sh\n");
		process.env.CHUNKHOUND_BIN = file;
		assert.equal(binaryExists(), true);
	});

	test("false for a missing absolute path", () => {
		process.env.CHUNKHOUND_BIN = join(dir, "does-not-exist");
		assert.equal(binaryExists(), false);
	});

	test("true when the binary is found on PATH", () => {
		writeFileSync(join(dir, "fake-ch-tool"), "#!/bin/sh\n");
		process.env.CHUNKHOUND_BIN = "fake-ch-tool";
		process.env.PATH = dir;
		assert.equal(binaryExists(), true);
	});

	test("false when not on PATH", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "pi-ch-empty-"));
		try {
			process.env.CHUNKHOUND_BIN = "no-such-tool-anywhere";
			process.env.PATH = emptyDir;
			assert.equal(binaryExists(), false);
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});
});

describe("runChunkhound", () => {
	test("returns stdout as text with details on success", async () => {
		const exec = fakeExec(ok("found things"));
		const r = await runChunkhound(exec, {
			args: ["search", "q"],
			label: "search",
			cwd: "/proj",
			timeoutMs: 1000,
			maxOutputChars: 1000,
		});
		assert.equal(r.text, "found things");
		assert.equal(r.details.exitCode, 0);
		assert.equal(r.details.truncated, false);
		assert.equal(r.details.command, "chunkhound search q");
		assert.ok(r.details.durationMs >= 0);
	});

	test("forwards cwd, timeout and signal to exec", async () => {
		const exec = fakeExec(ok());
		const controller = new AbortController();
		await runChunkhound(exec, {
			args: ["index"],
			label: "index",
			cwd: "/proj",
			timeoutMs: 4242,
			maxOutputChars: 100,
			signal: controller.signal,
		});
		assert.equal(exec.calls.length, 1);
		assert.deepEqual(exec.calls[0]?.options, {
			cwd: "/proj",
			signal: controller.signal,
			timeout: 4242,
		});
	});

	test("falls back to stderr, then '(no output)'", async () => {
		const stderrOnly = await runChunkhound(fakeExec({ stdout: "", stderr: "warn", code: 0, killed: false }), {
			args: ["x"], label: "x", cwd: "/p", timeoutMs: 1, maxOutputChars: 100,
		});
		assert.equal(stderrOnly.text, "warn");

		const silent = await runChunkhound(fakeExec({ stdout: "", stderr: "", code: 0, killed: false }), {
			args: ["x"], label: "x", cwd: "/p", timeoutMs: 1, maxOutputChars: 100,
		});
		assert.equal(silent.text, "(no output)");
	});

	test("emits an immediate start update via onUpdate", async () => {
		const updates: string[] = [];
		await runChunkhound(fakeExec(ok()), {
			args: ["search", "q"],
			label: "search",
			cwd: "/p",
			timeoutMs: 1,
			maxOutputChars: 100,
			onUpdate: (u) => updates.push(u.content[0]?.text ?? ""),
		});
		assert.ok(updates[0]?.includes("ChunkHound search started"));
	});

	test("throws with exit code and stderr tail on non-zero exit", async () => {
		const exec = fakeExec({ stdout: "", stderr: "boom\nstack\ntrace", code: 2, killed: false });
		await assert.rejects(
			runChunkhound(exec, {
				args: ["search", "q"], label: "search", cwd: "/p", timeoutMs: 1, maxOutputChars: 100,
			}),
			/exited with code 2[\s\S]*boom[\s\S]*trace/,
		);
	});

	test("throws with timeout hint when the process was killed", async () => {
		const exec = fakeExec({ stdout: "", stderr: "", code: null, killed: true });
		await assert.rejects(
			runChunkhound(exec, {
				args: ["research", "q"], label: "research", cwd: "/p", timeoutMs: 1000, maxOutputChars: 100,
			}),
			/killed.*timeout.*CHUNKHOUND_\*_TIMEOUT_MS/s,
		);
	});

	test("appends the db-missing hint on success when output says Database not found", async () => {
		const exec = fakeExec(ok("Database not found at /x/y.db"));
		const r = await runChunkhound(exec, {
			args: ["search", "q"], label: "search", cwd: "/p", timeoutMs: 1, maxOutputChars: 100,
			dbMissingHint: "call chunkhound_index first",
		});
		assert.ok(r.text.includes("Database not found"));
		assert.ok(r.text.includes("call chunkhound_index first"));
	});

	test("appends the db-missing hint to the error on failure", async () => {
		const exec = fakeExec({ stdout: "", stderr: "Database not found", code: 1, killed: false });
		await assert.rejects(
			runChunkhound(exec, {
				args: ["search", "q"], label: "search", cwd: "/p", timeoutMs: 1, maxOutputChars: 100,
				dbMissingHint: "call chunkhound_index first",
			}),
			/call chunkhound_index first/,
		);
	});

	test("rejects before spawning when the signal is already aborted", async () => {
		const exec = fakeExec(ok());
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			runChunkhound(exec, {
				args: ["x"], label: "x", cwd: "/p", timeoutMs: 1, maxOutputChars: 100,
				signal: controller.signal,
			}),
			/cancelled before start/,
		);
		assert.equal(exec.calls.length, 0);
	});

	test("returns a cancelled message when aborted mid-run", async () => {
		const controller = new AbortController();
		const exec: ExecFn = async () => {
			controller.abort(); // abort lands while the "process" is running
			return { stdout: "partial", stderr: "", code: 0, killed: false };
		};
		const r = await runChunkhound(exec, {
			args: ["x"], label: "x", cwd: "/p", timeoutMs: 1, maxOutputChars: 100,
			signal: controller.signal,
		});
		assert.equal(r.text, "ChunkHound x cancelled.");
		assert.equal(r.details.exitCode, null);
	});

	test("heartbeat fires while running and stops after completion", async (t) => {
		const updates: string[] = [];
		const exec: ExecFn = () =>
			new Promise((res) => {
				setTimeout(() => res(ok("done")), 50);
			});

		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		try {
			const promise = runChunkhound(exec, {
				args: ["research", "q"],
				label: "research",
				cwd: "/p",
				timeoutMs: 60_000,
				maxOutputChars: 100,
				onUpdate: (u) => updates.push(u.content[0]?.text ?? ""),
			});

			await t.mock.timers.tick(15_000); // first heartbeat due
			await t.mock.timers.tick(15_000); // second heartbeat due
			await t.mock.timers.tick(60_000); // exec's 50ms timer fires, promise resolves
			const r = await promise;

			assert.equal(r.text, "done");
			assert.ok(updates.some((u) => u.includes("still running")), `updates: ${updates.join(" | ")}`);

			const count = updates.length;
			await t.mock.timers.tick(60_000);
			assert.equal(updates.length, count, "no heartbeat after completion");
		} finally {
			t.mock.timers.reset();
		}
	});
});
