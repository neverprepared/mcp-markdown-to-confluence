# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Overview

`@neverprepared/mcp-markdown-to-confluence` is an MCP (Model Context Protocol) **stdio server**
that converts Markdown to Atlassian Document Format (ADF) and publishes it to Confluence Cloud.
Diagrams in fenced code blocks (Mermaid + 16 Kroki types) are rendered to images by a **Kroki**
service and uploaded as page attachments.

TypeScript, ESM, Node >= 20. No test suite and no linter are configured (see Verification).

## Architecture

```
bin/mcp-markdown-to-confluence.js   # entry point: registers dist/loader.js, imports dist/index.js
src/loader.js                       # Node module-resolution hook, copied verbatim to dist/ at build
src/index.ts                        # the whole server: tools, Confluence I/O, dir tree publish (~1100 LOC)
src/kroki/                          # Kroki rendering layer
  KrokiClient.ts                    # POST <KROKI_URL>/<type>/<format>, returns a Buffer
  KrokiMermaidRenderer.ts           # implements @markdown-confluence/lib MermaidRenderer via Kroki
  KrokiDiagramPlugin.ts             # ADFProcessingPlugin: extract/transform/load one diagram type
docker/kroki/docker-compose.yml     # local Kroki + kroki-mermaid (host port 127.0.0.1:8371)
scripts/postinstall.sh              # copies that compose file to ~/.config/neverprepared-mcp-servers/kroki/
```

Key design points, all load-bearing — do not "clean them up" without checking:

- **Deep imports into `@markdown-confluence/lib/dist/...`** (`MdToADF.js`, `ADFToMarkdown.js`,
  `ADFProcessingPlugins/types.js`, `MermaidRendererPlugin.js`). This deliberately avoids
  `adaptors/filesystem.js`, whose CJS named exports are broken. The lib version is **pinned**
  (`5.5.2`) because these paths are internal.
- **`src/loader.js`** is a `node:module` resolve/load hook that patches around the same package's
  extensionless / directory imports and JSON import attributes. `npm run build` copies it into
  `dist/` (tsc does not).
- **`stubAdaptor`** in `src/index.ts` satisfies the `LoaderAdaptor` type; only `uploadBuffer` is
  ever reached in MCP context.
- **Publish is two-step against Confluence**: create a blank ADF placeholder page to obtain a
  `pageId`, run the ADF processing pipeline (which uploads diagram attachments to that page),
  then `updateContent` with the final ADF at `version + 1`.
- **Directory publish** scans the tree, publishes **breadth-first level by level** (a level's
  parents must exist before its children), with a `pLimit`-style concurrency gate, then does a
  **second pass** to resolve `[[Wiki Links]]` / `[[Page#Heading]]` / `[[Page|Label]]` into real
  Confluence URLs and republishes only the pages that contain them.
- A `<name>.md` file sitting next to a `<name>/` directory supplies that directory page's
  frontmatter/title instead of becoming a sibling page.
- Path inputs go through `validatePath()`: absolute-only, no `..` segments, then `realpath()`.
- `attachmentCache` is a process-lifetime cache keyed by page ID (used by the wiki-link pass).

## MCP tools exposed

| Tool | Required | Optional | Behaviour |
|---|---|---|---|
| `markdown_preview` | `markdown`, `title` | — | Markdown → ADF → text preview. Never calls Confluence. |
| `markdown_publish` | `markdown`, `title`, `spaceKey` | `pageId`, `parentId`, `skip_preview` | Creates or updates a page. |
| `markdown_publish_file` | `filePath` | `skip_preview` | Reads a `.md` file; title/space/page come from frontmatter. |
| `markdown_publish_directory` | `directoryPath`, `spaceKey` | `rootPageId`, `skip_preview`, `concurrency` | Mirrors a folder tree as a Confluence page tree. |

No MCP resources or prompts are registered — tools only (`capabilities: { tools: {} }`).

**Preview gate:** every publishing tool returns a preview and publishes nothing unless
`skip_preview: true` is passed. Preserve this behaviour.

**Frontmatter keys:** `connie-title` (falls back to `title`, then the filename stem),
`connie-space-key`, `connie-page-id`. Files missing a title or space key are *skipped*, not failed.

**Input validation:** tool arguments are parsed with zod inside each handler (the `inputSchema`
in `ListTools` is hand-written JSON Schema). `concurrency` is clamped to 1..20, default 5.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `CONFLUENCE_URL` | `''` | Base URL, e.g. `https://org.atlassian.net`. A trailing `/wiki` is stripped. |
| `CONFLUENCE_USERNAME` | `''` | Atlassian account email (basic auth). |
| `CONFLUENCE_API_TOKEN` | `''` | Atlassian API token. |
| `KROKI_URL` | `http://localhost:8371` | Kroki service base URL. |

Note: `README.md` documents `CONFLUENCE_BASE_URL`, which the code does **not** read.

## Key commands

```bash
npm install            # runs scripts/postinstall.sh (installs the Kroki compose file)
npm run build          # tsc -> dist/ and copies src/loader.js to dist/loader.js
npm start              # node bin/mcp-markdown-to-confluence.js (stdio MCP server)
npm run dev            # same, with --watch

# local Kroki (required for diagram rendering)
docker compose -f docker/kroki/docker-compose.yml up -d
```

There is **no** `test` or `lint` script. `npm run build` is the only gate — CI
(`.github/workflows/ci.yml`) runs exactly `npm ci` + `npm run build` on push/PR to `main`.

## Verification

Run `npm run build` before proposing changes; it is the full local check. If you add behaviour
that warrants tests, say so explicitly — there is no harness to drop them into yet.

## Conventions

- ESM only (`"type": "module"`); use `.js` extensions in relative TypeScript imports.
- `strict` TypeScript. `any` casts appear only at the `@markdown-confluence/lib` /
  `confluence.js` boundary, with an explanatory comment — keep them contained there.
- Diagram output format per type lives in `KROKI_DIAGRAM_CONFIGS` (PNG where supported,
  SVG otherwise); `SUPPORTED_DIAGRAM_TYPES` is derived from it plus `mermaid`. Add new types there.
- Errors are surfaced as MCP text content, not thrown — per-file failures in a directory publish
  are collected and reported, never abort the run.
- Releases are automated by **release-please** (`.github/workflows/release-please.yml`) and publish
  to npm. Use Conventional Commit messages (`feat:`, `fix:`, `chore:`); do not hand-edit
  `CHANGELOG.md` or bump `version` in `package.json`.
