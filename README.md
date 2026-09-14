# pi-chunkhound

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension exposing [ChunkHound](https://github.com/bloopapps/chunkhound) codebase intelligence as agent tools — by wrapping the `chunkhound` CLI.

No runtime dependencies: tools spawn one-shot `chunkhound` subprocesses with proper cancellation, timeouts, heartbeat progress, and output truncation.

## Tools

| Tool | Wraps | Purpose |
|------|-------|---------|
| `chunkhound_search` | `chunkhound search` | Semantic / regex / single-hop / multi-hop code search over an indexed codebase, with pagination (`page_size`, `offset`) and git-history scoping (`last_n`, `commit_hash`, `commit_range`, `vector_source`) |
| `chunkhound_research` | `chunkhound research` | Deep multi-file research with a cited answer (slow — minutes) |
| `chunkhound_websearch` | `chunkhound websearch` | Cited technical web research via DuckDuckGo + reranking (supports `previous_query` refinement) |
| `chunkhound_fetchurl` | `chunkhound fetchurl` | Fetch one URL and distill a focused Markdown answer |
| `chunkhound_index` | `chunkhound index` | (Re)build the index (incremental, or `force`) |

Command: `/chunkhound` — status (binary, version, index database, provider config).

## Install

Requires the `chunkhound` binary on `PATH` (if it is missing, the extension registers nothing — silent opt-out) and, for embedding/LLM-backed operations (semantic search, research, websearch, fetchurl), a `.chunkhound.json` provider config in the project. Regex search and indexing work without LLM/embedding config.

```bash
# From this repo (git)
pi install git:github.com/bienwithcode/pi-chunkhound
# Project-local instead of global
pi install -l git:github.com/bienwithcode/pi-chunkhound

# Local development (loads for the current run only, hot-reloadable via /reload)
pi -e /path/to/pi-chunkhound/extension.ts
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `CHUNKHOUND_BIN` | `chunkhound` | Binary name or absolute path |
| `CHUNKHOUND_SEARCH_TIMEOUT_MS` | `300000` | Search timeout (5 min) |
| `CHUNKHOUND_RESEARCH_TIMEOUT_MS` | `900000` | Research timeout (15 min) |
| `CHUNKHOUND_WEBSEARCH_TIMEOUT_MS` | `180000` | Web search timeout (3 min) |
| `CHUNKHOUND_FETCHURL_TIMEOUT_MS` | `180000` | Fetch URL timeout (3 min) |
| `CHUNKHOUND_INDEX_TIMEOUT_MS` | `1800000` | Index timeout (30 min) |

Output is truncated (search 50k, research 150k, fetchurl 80k, websearch 40k, index 20k chars) to protect the model context window; the truncation marker is visible in the result.

## Development

```bash
npm install        # dev deps only (types) — runtime peers are provided by pi
npx tsc --noEmit   # type-check
```

`extension.ts` is the entry point; `lib/runner.ts` holds the subprocess runner (exec, heartbeat, truncation, timeout handling).

## Security

Extensions run with your full user permissions, and these tools execute the `chunkhound` binary against your filesystem. Only install from sources you trust. ChunkHound provider keys live in `.chunkhound.json` — never commit them.

## License

MIT
