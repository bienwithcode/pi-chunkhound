/**
 * Tests for index.ts — extension registration and tool→CLI argument wiring,
 * using a mocked ExtensionAPI (registerTool/registerCommand/exec captured).
 * Run: npm test (node --test test/)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import chunkhoundExtension from "../index.ts";
import { type ExecFn } from "../lib/runner.ts";

// ---------------------------------------------------------------------------
// Minimal ExtensionAPI mock
// ---------------------------------------------------------------------------

type ToolDef = {
	name: string;
	parameters: unknown;
	description: string;
	execute: (
		toolCallId: string,
		params: Record<string, never> & Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((u: unknown) => void) | undefined,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};
type CommandDef = { description: string; handler: (args: string, ctx: unknown) => Promise<void> };

type ExecResult = { stdout: string; stderr: string; code: number | null; killed: boolean };

function makePi() {
	const tools: ToolDef[] = [];
	const commands = new Map<string, CommandDef>();
	const execCalls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
	let execImpl: ExecFn = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

	const pi = {
		registerTool: (def: ToolDef) => tools.push(def),
		registerCommand: (name: string, def: CommandDef) => commands.set(name, def),
		exec: (command: string, args: string[], options?: Record<string, unknown>) => {
			execCalls.push({ command, args, options });
			return execImpl(command, args, options as never);
		},
	};

	return {
		pi,
		tools,
		commands,
		execCalls,
		setExec: (fn: ExecFn) => {
			execImpl = fn;
		},
		tool: (name: string) => {
			const t = tools.find((x) => x.name === name);
			assert.ok(t, `tool ${name} should be registered (have: ${tools.map((x) => x.name).join(", ")})`);
			return t;
		},
	};
}

/** Point CHUNKHOUND_BIN at an existing file so registration is not skipped. */
let tmpBinFile: string;
let cwd: string;

function activate() {
	process.env.CHUNKHOUND_BIN = tmpBinFile;
}

async function runTool(
	tool: ToolDef,
	params: Record<string, unknown>,
	opts?: { cwd?: string; signal?: AbortSignal },
) {
	return tool.execute(
		"call-1",
		params as never,
		opts?.signal,
		undefined,
		{ cwd: opts?.cwd ?? cwd },
	);
}

// ---------------------------------------------------------------------------

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ch-index-"));
	tmpBinFile = join(dir, "fake-chunkhound");
	writeFileSync(tmpBinFile, "#!/bin/sh\n");
	cwd = join(dir, "project");
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	rmSync(join(tmpBinFile, ".."), { recursive: true, force: true });
});

describe("registration", () => {
	test("registers nothing when the binary is missing (silent opt-out)", () => {
		process.env.CHUNKHOUND_BIN = join(tmpdir(), "definitely-missing-chunkhound-bin");
		const { pi, tools, commands } = makePi();
		chunkhoundExtension(pi as never);
		assert.equal(tools.length, 0);
		assert.equal(commands.size, 0);
	});

	test("registers five tools and the /chunkhound command when the binary exists", () => {
		activate();
		const { pi, tools, commands } = makePi();
		chunkhoundExtension(pi as never);
		assert.deepEqual(
			tools.map((t) => t.name),
			[
				"chunkhound_search",
				"chunkhound_research",
				"chunkhound_websearch",
				"chunkhound_fetchurl",
				"chunkhound_index",
			],
		);
		assert.ok(commands.has("chunkhound"));
	});
});

describe("chunkhound_search wiring", () => {
	test("defaults to semantic mode with just the query", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));

		const r = await runTool(m.tool("chunkhound_search"), { query: "how does auth work" });
		assert.deepEqual(m.execCalls[0]?.args, ["search", "--semantic", "how does auth work"]);
		assert.equal(r.content[0]?.type, "text");
		assert.equal(r.content[0]?.text, "ok");
		assert.equal(r.details.exitCode, 0);
		assert.equal(m.execCalls[0]?.options?.cwd, cwd);
	});

	test("maps mode, path_filter, page_size, offset and git scope to flags", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));

		await runTool(m.tool("chunkhound_search"), {
			query: "pattern",
			mode: "regex",
			path_filter: "internal/",
			page_size: 5,
			offset: 10,
			last_n: 20,
			vector_source: "both",
		});
		assert.deepEqual(m.execCalls[0]?.args, [
			"search",
			"--regex",
			"--path-filter",
			"internal/",
			"--page-size",
			"5",
			"--offset",
			"10",
			"--last-n",
			"20",
			"--vector-source",
			"both",
			"pattern",
		]);
	});

	test("resolves a @-prefixed relative path against cwd", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));

		await runTool(m.tool("chunkhound_search"), { query: "q", path: "@sub/dir" });
		assert.equal(m.execCalls[0]?.args.at(-1), join(cwd, "sub/dir"));
	});

	test("rejects mutually exclusive git-scope flags", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);

		await assert.rejects(
			runTool(m.tool("chunkhound_search"), { query: "q", last_n: 5, commit_hash: "abc123" }),
			/mutually exclusive/,
		);
		assert.equal(m.execCalls.length, 0, "must not spawn a process on validation failure");
	});

	test("appends the index hint when the database is missing", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({
			stdout: "Database not found at /x/chunks.db",
			stderr: "",
			code: 0,
			killed: false,
		}));

		const r = await runTool(m.tool("chunkhound_search"), { query: "q" });
		assert.ok(r.content[0]?.text.includes("chunkhound_index"), `text: ${r.content[0]?.text}`);
	});
});

describe("chunkhound_research wiring", () => {
	test("places the question last, with path_filter and git scope before it", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "answer", stderr: "", code: 0, killed: false }));

		await runTool(m.tool("chunkhound_research"), {
			question: "how does login work end to end?",
			path_filter: "internal/",
			commit_range: "v1..v2",
		});
		assert.deepEqual(m.execCalls[0]?.args, [
			"research",
			"--path-filter",
			"internal/",
			"--commit-range",
			"v1..v2",
			"how does login work end to end?",
		]);
	});
});

describe("chunkhound_websearch wiring", () => {
	test("maps limit and previous_query", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "results", stderr: "", code: 0, killed: false }));

		await runTool(m.tool("chunkhound_websearch"), {
			query: "pi extensions",
			limit: 3,
			previous_query: "pi coding agent",
		});
		assert.deepEqual(m.execCalls[0]?.args, [
			"websearch",
			"--limit",
			"3",
			"--previous-query",
			"pi coding agent",
			"pi extensions",
		]);
	});
});

describe("chunkhound_fetchurl wiring", () => {
	test("maps the focus query flag", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "page", stderr: "", code: 0, killed: false }));

		await runTool(m.tool("chunkhound_fetchurl"), { url: "https://example.com/docs", query: "auth" });
		assert.deepEqual(m.execCalls[0]?.args, [
			"fetchurl",
			"--query",
			"auth",
			"https://example.com/docs",
		]);
	});
});

describe("chunkhound_index wiring", () => {
	test("defaults to the project cwd and incremental mode", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "indexed", stderr: "", code: 0, killed: false }));

		await runTool(m.tool("chunkhound_index"), {});
		assert.deepEqual(m.execCalls[0]?.args, ["index", cwd]);
	});

	test("uses --force-reindex (not --force) and resolves the path", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "indexed", stderr: "", code: 0, killed: false }));

		await runTool(m.tool("chunkhound_index"), { path: "packages/app", force: true });
		assert.deepEqual(m.execCalls[0]?.args, ["index", "--force-reindex", join(cwd, "packages/app")]);
	});
});

describe("/chunkhound command", () => {
	function makeCtx(dir: string) {
		const notifications: Array<{ message: string; level: string }> = [];
		return {
			notifications,
			ctx: {
				cwd: dir,
				ui: {
					notify: (message: string, level: string) => notifications.push({ message, level }),
				},
			},
		};
	}

	test("reports binary, version, existing db and provider config", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "chunkhound 9.9.9\n", stderr: "", code: 0, killed: false }));

		mkdirSync(join(cwd, ".chunkhound", "db"), { recursive: true });
		writeFileSync(join(cwd, ".chunkhound", "db", "chunks.db"), "");
		writeFileSync(join(cwd, ".chunkhound.json"), "{}");

		const { ctx, notifications } = makeCtx(cwd);
		await m.commands.get("chunkhound")?.handler("", ctx);

		assert.equal(notifications.length, 1);
		const msg = notifications[0]?.message ?? "";
		assert.ok(msg.includes("binary:"), msg);
		assert.ok(msg.includes("chunkhound 9.9.9"), msg);
		assert.ok(msg.includes("(exists)"), msg);
		assert.ok(msg.includes(".chunkhound.json found"), msg);
		assert.equal(notifications[0]?.level, "info");
	});

	test("flags a missing db and config", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => ({ stdout: "chunkhound 9.9.9\n", stderr: "", code: 0, killed: false }));

		const { ctx, notifications } = makeCtx(cwd);
		await m.commands.get("chunkhound")?.handler("", ctx);

		const msg = notifications[0]?.message ?? "";
		assert.ok(msg.includes("(missing"), msg);
		assert.ok(msg.includes("no .chunkhound.json"), msg);
	});

	test("warns when the binary is not runnable", async () => {
		activate();
		const m = makePi();
		chunkhoundExtension(m.pi as never);
		m.setExec(async () => {
			throw new Error("ENOENT");
		});

		const { ctx, notifications } = makeCtx(cwd);
		await m.commands.get("chunkhound")?.handler("", ctx);

		assert.equal(notifications[0]?.level, "warning");
		assert.ok(notifications[0]?.message.includes("NOT RUNNABLE"));
	});
});
