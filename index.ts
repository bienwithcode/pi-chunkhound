/**
 * pi-chunkhound — Pi coding-agent extension exposing ChunkHound
 * codebase intelligence by wrapping the `chunkhound` CLI.
 *
 * Tools:
 *   - chunkhound_search    semantic/regex/single-hop/multi-hop code search (+ git-history scoping)
 *   - chunkhound_research  deep, cited code research (slow — minutes)
 *   - chunkhound_websearch technical web research with citations
 *   - chunkhound_fetchurl  fetch one URL, get a focused Markdown answer
 *   - chunkhound_index     (re)build the local index
 *
 * Command:
 *   /chunkhound            status: binary, version, index database, provider config
 *
 * Requirements:
 *   - chunkhound on PATH (or CHUNKHOUND_BIN env var pointing to the binary)
 *   - If the binary is missing, the extension registers nothing (silent).
 *   - Embedding/LLM-backed operations need .chunkhound.json provider config;
 *     regex search and indexing work without it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	binaryExists,
	chunkhoundBin,
	envTimeoutMs,
	resolvePathArg,
	runChunkhound,
	type ExecFn,
} from "./lib/runner.ts";

const DB_RELATIVE_PATH = join(".chunkhound", "db", "chunks.db");
const INDEX_HINT = "call chunkhound_index first to build it";

interface GitScope {
	last_n?: number;
	commit_hash?: string;
	commit_range?: string;
	/** Constrained to 'diff' | 'db' | 'both' by the tool schema (StringEnum widens to string in static types). */
	vector_source?: string;
}

/** Mutually exclusive git-history flags, appended only when provided. */
function gitScopeArgs(scope: GitScope): string[] {
	const args: string[] = [];
	const provided = [scope.last_n, scope.commit_hash, scope.commit_range].filter(
		(v) => v !== undefined,
	);
	if (provided.length > 1) {
		throw new Error(
			"Provide at most one of last_n, commit_hash, commit_range — they are mutually exclusive.",
		);
	}
	if (scope.last_n !== undefined) args.push("--last-n", String(scope.last_n));
	if (scope.commit_hash) args.push("--commit-hash", scope.commit_hash);
	if (scope.commit_range) args.push("--commit-range", scope.commit_range);
	if (scope.vector_source) args.push("--vector-source", scope.vector_source);
	return args;
}

const gitScopeSchema = {
	last_n: Type.Optional(
		Type.Integer({ minimum: 1, description: "Search last N commits (e.g. 20 for recent changes)" }),
	),
	commit_hash: Type.Optional(
		Type.String({ description: "Single commit hash — searches only that commit's diff" }),
	),
	commit_range: Type.Optional(
		Type.String({ description: "Git revision range, e.g. 'main..HEAD' or 'v1.0..v2.0'" }),
	),
	vector_source: Type.Optional(
		StringEnum(["diff", "db", "both"], {
			description: "Scope when git input given: 'diff' (default) changed code only, 'db' index only, 'both' merged",
		}),
	),
} as const;

export default function chunkhoundExtension(pi: ExtensionAPI) {
	// Silent opt-out: without the binary, registering tools that always error
	// would only pollute sessions. Install chunkhound, then /reload to activate.
	if (!binaryExists()) return;

	const exec = pi.exec as ExecFn;
	const timeout = (name: string, def: number) => envTimeoutMs(name, def);

	// ---------- chunkhound_search ----------
	pi.registerTool({
		name: "chunkhound_search",
		label: "ChunkHound Search",
		description:
			"Semantic (by meaning) or regex code search over the indexed codebase, with optional git-history scoping (last N commits, a commit, or a range). Requires the index to exist (chunkhound_index).",
		promptSnippet: "ChunkHound code search (semantic/regex, current code and git history)",
		promptGuidelines: [
			"Use chunkhound_search before ripgrep when the question is conceptual (architecture, behavior, 'where is X handled') or when you need to find code by meaning rather than exact strings.",
			"Use chunkhound_search with last_n or commit_range to answer 'what changed recently/between releases' questions instead of manually diffing.",
			"Run chunkhound_index when chunkhound_search reports a missing or stale index, or once after large code changes.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (natural language for semantic mode, pattern for regex mode)",
			}),
			mode: Type.Optional(
				StringEnum(["semantic", "regex", "single-hop", "multi-hop"], {
					description: "Search mode (default semantic)",
				}),
			),
			path: Type.Optional(
				Type.String({ description: "Directory to search, relative to cwd (default: project root)" }),
			),
			path_filter: Type.Optional(
				Type.String({ description: "Narrow results to a subtree, e.g. 'internal/'" }),
			),
			page_size: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, description: "Results per page (default 10)" }),
			),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Pagination offset (default 0)" }),
			),
			...gitScopeSchema,
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args: string[] = ["search", `--${params.mode ?? "semantic"}`];
			if (params.path_filter) args.push("--path-filter", params.path_filter);
			if (params.page_size !== undefined) args.push("--page-size", String(params.page_size));
			if (params.offset !== undefined) args.push("--offset", String(params.offset));
			args.push(...gitScopeArgs(params));
			args.push(params.query);
			const path = resolvePathArg(params.path, ctx.cwd);
			if (path) args.push(path);

			const result = await runChunkhound(exec, {
				args,
				label: "search",
				cwd: ctx.cwd,
				timeoutMs: timeout("CHUNKHOUND_SEARCH_TIMEOUT_MS", 5 * 60_000),
				maxOutputChars: 50_000,
				dbMissingHint: INDEX_HINT,
				signal,
				onUpdate,
			});
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	// ---------- chunkhound_research ----------
	pi.registerTool({
		name: "chunkhound_research",
		label: "ChunkHound Research",
		description:
			"Deep code research: asks a question about the codebase (optionally scoped to git history) and returns a cited answer grounded in source files. Slower than chunkhound_search (may take minutes). Requires LLM + embedding providers configured in .chunkhound.json.",
		promptSnippet: "ChunkHound deep code research with citations",
		promptGuidelines: [
			"Use chunkhound_research only when chunkhound_search results are not enough and the task needs a multi-file, cited explanation (e.g. 'how does auth work end to end') — it can take minutes.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "Research question about the codebase" }),
			path: Type.Optional(
				Type.String({ description: "Directory to research, relative to cwd (default: project root)" }),
			),
			path_filter: Type.Optional(
				Type.String({ description: "Narrow research to a subtree, e.g. 'internal/'" }),
			),
			...gitScopeSchema,
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args: string[] = ["research"];
			if (params.path_filter) args.push("--path-filter", params.path_filter);
			args.push(...gitScopeArgs(params));
			args.push(params.question);
			const path = resolvePathArg(params.path, ctx.cwd);
			if (path) args.push(path);

			const result = await runChunkhound(exec, {
				args,
				label: "research",
				cwd: ctx.cwd,
				timeoutMs: timeout("CHUNKHOUND_RESEARCH_TIMEOUT_MS", 15 * 60_000),
				maxOutputChars: 150_000,
				dbMissingHint: INDEX_HINT,
				signal,
				onUpdate,
			});
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	// ---------- chunkhound_websearch ----------
	pi.registerTool({
		name: "chunkhound_websearch",
		label: "ChunkHound Web Search",
		description:
			"Pinpoint technical web research (docs, APIs, issues, articles) with cited results via DuckDuckGo + reranking. Complements local code research. Requires LLM + embedding providers configured in .chunkhound.json.",
		promptSnippet: "ChunkHound cited technical web research",
		promptGuidelines: [
			"Use chunkhound_websearch for up-to-date external documentation or library references; do not use it to search the local codebase.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Web research query" }),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 10, description: "Max results (default 5)" }),
			),
			previous_query: Type.Optional(
				Type.String({ description: "Prior query, for iterative refinement" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args: string[] = ["websearch"];
			if (params.limit !== undefined) args.push("--limit", String(params.limit));
			if (params.previous_query) args.push("--previous-query", params.previous_query);
			args.push(params.query);

			const result = await runChunkhound(exec, {
				args,
				label: "websearch",
				cwd: ctx.cwd,
				timeoutMs: timeout("CHUNKHOUND_WEBSEARCH_TIMEOUT_MS", 3 * 60_000),
				maxOutputChars: 40_000,
				signal,
				onUpdate,
			});
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	// ---------- chunkhound_fetchurl ----------
	pi.registerTool({
		name: "chunkhound_fetchurl",
		label: "ChunkHound Fetch URL",
		description:
			"Fetch a single URL (http/https) and get a focused Markdown answer, optionally guided by a query. Useful for reading a specific doc page or issue thread. Requires LLM providers configured in .chunkhound.json.",
		promptSnippet: "ChunkHound fetch one URL and distill a focused Markdown answer",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http:// or https:// only)" }),
			query: Type.Optional(
				Type.String({ description: "Optional focus question for the extracted answer" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args: string[] = ["fetchurl"];
			if (params.query) args.push("--query", params.query);
			args.push(params.url);

			const result = await runChunkhound(exec, {
				args,
				label: "fetchurl",
				cwd: ctx.cwd,
				timeoutMs: timeout("CHUNKHOUND_FETCHURL_TIMEOUT_MS", 3 * 60_000),
				maxOutputChars: 80_000,
				signal,
				onUpdate,
			});
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	// ---------- chunkhound_index ----------
	pi.registerTool({
		name: "chunkhound_index",
		label: "ChunkHound Index",
		description:
			"(Re)build the ChunkHound index for a directory so search/research tools work. Incremental by default; pass force for a full reindex. Slow on first run (embeds every file). Run after significant code changes or when search reports a missing database.",
		promptSnippet: "ChunkHound index (re)build",
		promptGuidelines: [
			"Call chunkhound_index when chunkhound_search or chunkhound_research report a missing database, or once after large code changes before relying on search results.",
		],
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({ description: "Directory to index, relative to cwd (default: project root)" }),
			),
			force: Type.Optional(
				Type.Boolean({ description: "Force full reindex (default false — incremental)" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args: string[] = ["index"];
			if (params.force) args.push("--force-reindex");
			args.push(resolvePathArg(params.path, ctx.cwd) ?? ctx.cwd);

			const result = await runChunkhound(exec, {
				args,
				label: "index",
				cwd: ctx.cwd,
				timeoutMs: timeout("CHUNKHOUND_INDEX_TIMEOUT_MS", 30 * 60_000),
				maxOutputChars: 20_000,
				signal,
				onUpdate,
			});
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	// ---------- /chunkhound command ----------
	pi.registerCommand("chunkhound", {
		description: "ChunkHound status (binary, version, index database, provider config)",
		handler: async (_args, ctx) => {
			const bin = chunkhoundBin();
			let version = "unknown";
			let binaryOk = true;
			try {
				const r = await exec(bin, ["--version"], { timeout: 15_000, cwd: ctx.cwd });
				version = (r.stdout || r.stderr).trim().split("\n")[0] || "unknown";
			} catch (error) {
				binaryOk = false;
				version = error instanceof Error ? error.message : String(error);
			}
			const dbPath = join(ctx.cwd, DB_RELATIVE_PATH);
			const lines = [
				`binary:   ${binaryOk ? bin : `${bin} (NOT RUNNABLE)`}`,
				`version:  ${version}`,
				`index:    ${dbPath}${existsSync(dbPath) ? " (exists)" : ` (missing — ${INDEX_HINT})`}`,
				`config:   ${existsSync(join(ctx.cwd, ".chunkhound.json")) ? ".chunkhound.json found" : "no .chunkhound.json (semantic search needs an embedding provider)"}`,
			];
			ctx.ui.notify(lines.join("\n"), binaryOk ? "info" : "warning");
		},
	});
}
