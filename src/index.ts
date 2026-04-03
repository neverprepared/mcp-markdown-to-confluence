import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ConfluenceClient } from 'confluence.js';
import matter from 'gray-matter';
import { readFile, readdir } from 'fs/promises';
import { join, extname, basename, relative } from 'path';

// Deep imports to avoid loading adaptors/filesystem.js which has broken CJS named exports.
// Pin @markdown-confluence/lib version if these paths change.
import { parseMarkdownToADF } from '@markdown-confluence/lib/dist/MdToADF.js';
import { renderADFDoc } from '@markdown-confluence/lib/dist/ADFToMarkdown.js';
import {
  executeADFProcessingPipeline,
  createPublisherFunctions,
} from '@markdown-confluence/lib/dist/ADFProcessingPlugins/types.js';
import { MermaidRendererPlugin } from '@markdown-confluence/lib/dist/ADFProcessingPlugins/MermaidRendererPlugin.js';
import { KrokiClient, KrokiMermaidRenderer, KrokiDiagramPlugin } from './kroki/index.js';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const CONFLUENCE_BASE_URL = (process.env.CONFLUENCE_URL ?? process.env.CONFLUENCE_BASE_URL ?? '')
  .replace(/\/wiki\/?$/, '');
const CONFLUENCE_USERNAME = process.env.CONFLUENCE_USERNAME ?? '';
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN ?? '';
const KROKI_URL = process.env.KROKI_URL ?? 'http://localhost:8371';

// ---------------------------------------------------------------------------
// Kroki client
// ---------------------------------------------------------------------------

const krokiClient = new KrokiClient(KROKI_URL);

// Diagram types and their preferred output format
// PNG is preferred when supported; SVG is the universal fallback
const KROKI_DIAGRAM_CONFIGS: Array<{ type: string; format: 'png' | 'svg' }> = [
  { type: 'plantuml', format: 'png' },
  { type: 'graphviz', format: 'png' },
  { type: 'dot', format: 'png' },
  { type: 'ditaa', format: 'svg' },
  { type: 'nomnoml', format: 'svg' },
  { type: 'd2', format: 'svg' },
  { type: 'dbml', format: 'svg' },
  { type: 'erd', format: 'svg' },
  { type: 'svgbob', format: 'svg' },
  { type: 'pikchr', format: 'svg' },
  { type: 'bytefield', format: 'svg' },
  { type: 'wavedrom', format: 'svg' },
  { type: 'vega', format: 'svg' },
  { type: 'vega-lite', format: 'svg' },
  { type: 'bpmn', format: 'svg' },
  { type: 'c4plantuml', format: 'png' },
];

const SUPPORTED_DIAGRAM_TYPES = [
  'mermaid',
  ...KROKI_DIAGRAM_CONFIGS.map((c) => c.type),
];

// ---------------------------------------------------------------------------
// Confluence client
// ---------------------------------------------------------------------------

const confluenceClient = new ConfluenceClient({
  host: CONFLUENCE_BASE_URL,
  authentication: {
    basic: {
      email: CONFLUENCE_USERNAME,
      apiToken: CONFLUENCE_API_TOKEN,
    },
  },
});

// ---------------------------------------------------------------------------
// Stub LoaderAdaptor — only uploadBuffer is called by the mermaid plugin
// ---------------------------------------------------------------------------

const stubAdaptor = {
  readFile: async (_filePath: string) => undefined,
  readBinary: async (_filePath: string) => false as const,
  fileExists: async (_filePath: string) => false,
  listFiles: async () => [],
  uploadBuffer: async (
    _buffer: Buffer,
    _fileName: string,
    _mimeType: string
  ) => undefined,
} as unknown as import('@markdown-confluence/lib/dist/adaptors/index.js').LoaderAdaptor;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countDiagramBlocks(adf: unknown): number {
  if (typeof adf !== 'object' || adf === null) return 0;

  const node = adf as Record<string, unknown>;
  let count = 0;

  if (
    node['type'] === 'codeBlock' &&
    typeof node['attrs'] === 'object' &&
    node['attrs'] !== null &&
    SUPPORTED_DIAGRAM_TYPES.includes(
      (node['attrs'] as Record<string, unknown>)['language'] as string
    )
  ) {
    count += 1;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        count += countDiagramBlocks(item);
      }
    } else if (typeof value === 'object' && value !== null) {
      count += countDiagramBlocks(value);
    }
  }

  return count;
}

function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      queue.shift()!();
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

interface ParsedMarkdownFile {
  filePath: string;
  title: string;
  spaceKey: string;
  pageId?: string;
  content: string;
}

async function parseMarkdownFile(
  filePath: string,
  overrides?: { spaceKey?: string; titleFallback?: string }
): Promise<ParsedMarkdownFile | { skipped: true; filePath: string; reason: string }> {
  const raw = await readFile(filePath, 'utf-8');
  const parsed = matter(raw);

  const title: string =
    parsed.data['connie-title'] ?? parsed.data['title'] ?? overrides?.titleFallback ?? '';
  const spaceKey: string = overrides?.spaceKey ?? parsed.data['connie-space-key'] ?? '';
  const pageId: string | undefined = parsed.data['connie-page-id']
    ? String(parsed.data['connie-page-id'])
    : undefined;

  if (!title) {
    return { skipped: true, filePath, reason: 'Missing "connie-title" or "title" in frontmatter' };
  }
  if (!spaceKey) {
    return { skipped: true, filePath, reason: 'Missing "connie-space-key" in frontmatter' };
  }

  return { filePath, title, spaceKey, pageId, content: parsed.content };
}

// ---------------------------------------------------------------------------
// Directory tree scanning
// ---------------------------------------------------------------------------

interface DirectoryNode {
  relativePath: string;
  title: string;
  depth: number;
  parentRelativePath: string | null;
  markdownFile?: ParsedMarkdownFile;
  isDirectory: boolean;
  resolvedPageId?: string;
}

async function scanDirectoryTree(
  rootPath: string,
  spaceKey: string,
  currentPath: string = rootPath,
  depth: number = 0,
): Promise<{
  nodes: DirectoryNode[];
  skipped: Array<{ filePath: string; reason: string }>;
}> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const nodes: DirectoryNode[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];

  const relFromRoot = relative(rootPath, currentPath) || '.';
  const parentRel = depth === 0 ? null : (relative(rootPath, join(currentPath, '..')) || '.');

  // Collect subdirectories and markdown files
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const mdFiles = entries.filter(
    (e) => e.isFile() && extname(e.name).toLowerCase() === '.md' && !e.name.startsWith('.')
  );

  // Check for markdown files that correspond to subdirectories (e.g., "01 - Strategic.md" + "01 - Strategic/")
  const subdirNames = new Set(subdirs.map((d) => d.name));
  const dirMdFiles = new Set<string>();

  // Process markdown files
  for (const entry of mdFiles) {
    const filePath = join(currentPath, entry.name);
    const stem = basename(entry.name, extname(entry.name));

    // If this .md file has a matching subdirectory, it will be used as the directory's content
    if (subdirNames.has(stem)) {
      dirMdFiles.add(stem);
      continue; // handled when processing the subdirectory
    }

    const result = await parseMarkdownFile(filePath, {
      spaceKey,
      titleFallback: stem,
    });

    if ('skipped' in result) {
      skipped.push(result);
    } else {
      nodes.push({
        relativePath: relative(rootPath, filePath),
        title: result.title,
        depth,
        parentRelativePath: depth === 0 ? null : relFromRoot,
        markdownFile: result,
        isDirectory: false,
      });
    }
  }

  // Process subdirectories
  for (const dir of subdirs) {
    const dirPath = join(currentPath, dir.name);
    const dirRelPath = relative(rootPath, dirPath);

    // Check for a matching .md file to use as directory content
    const matchingMdPath = join(currentPath, dir.name + '.md');
    let dirMarkdownFile: ParsedMarkdownFile | undefined;

    if (dirMdFiles.has(dir.name)) {
      const result = await parseMarkdownFile(matchingMdPath, {
        spaceKey,
        titleFallback: dir.name,
      });
      if (!('skipped' in result)) {
        dirMarkdownFile = result;
      }
    }

    nodes.push({
      relativePath: dirRelPath,
      title: dirMarkdownFile?.title ?? dir.name,
      depth,
      parentRelativePath: depth === 0 ? null : relFromRoot,
      markdownFile: dirMarkdownFile,
      isDirectory: true,
    });

    // Recurse
    const subResult = await scanDirectoryTree(rootPath, spaceKey, dirPath, depth + 1);
    nodes.push(...subResult.nodes);
    skipped.push(...subResult.skipped);
  }

  return { nodes, skipped };
}

// ---------------------------------------------------------------------------
// Wiki link resolution
// ---------------------------------------------------------------------------

// Matches [[Page Name]] and [[Page Name#Heading]] and [[Page Name|Display Text]]
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

function hasWikiLinks(markdown: string): boolean {
  return WIKI_LINK_RE.test(markdown);
}

function resolveWikiLinks(
  markdown: string,
  titleToUrl: Map<string, string>,
): string {
  return markdown.replace(WIKI_LINK_RE, (_match, pageName: string, heading?: string, displayText?: string) => {
    const trimmedName = pageName.trim();
    const url = titleToUrl.get(trimmedName);

    if (!url) {
      // No matching page found — leave as plain text
      return displayText?.trim() || trimmedName;
    }

    const label = displayText?.trim() || trimmedName;
    const anchor = heading?.trim();
    const anchorSuffix = anchor
      ? '#' + anchor.replace(/\s+/g, '-')
      : '';

    return `[${label}](${url}${anchorSuffix})`;
  });
}

// ---------------------------------------------------------------------------
// Core publish logic
// ---------------------------------------------------------------------------

async function publishMarkdown(
  markdown: string,
  title: string,
  spaceKey: string,
  pageId?: string,
  parentId?: string,
  skipPreview = false
): Promise<{ isPreview: boolean; previewText?: string; diagramCount?: number; pageId?: string; version?: number; url?: string }> {
  // Parse markdown → ADF
  const adf = parseMarkdownToADF(
    markdown,
    CONFLUENCE_BASE_URL
  ) as unknown as any;

  const diagramCount = countDiagramBlocks(adf);

  if (!skipPreview) {
    const previewText = renderADFDoc(adf as unknown as any);
    return { isPreview: true, previewText, diagramCount };
  }

  // ----- Full publish -----

  let currentVersion = 1;
  let resolvedPageId = pageId;

  if (resolvedPageId) {
    // Fetch existing page to get current version
    const existingPage = await confluenceClient.content.getContentById({
      id: resolvedPageId,
      expand: ['version'],
    });
    currentVersion = existingPage.version!.number!;
  } else {
    // Create a placeholder page to obtain a pageId
    const blankAdf = {
      version: 1,
      type: 'doc',
      content: [],
    };

    const createParams: Parameters<typeof confluenceClient.content.createContent>[0] = {
      space: { key: spaceKey },
      title,
      type: 'page',
      body: {
        atlas_doc_format: {
          value: JSON.stringify(blankAdf),
          representation: 'atlas_doc_format',
        },
      },
    };

    if (parentId) {
      createParams.ancestors = [{ id: parentId }];
    }

    const created = await confluenceClient.content.createContent(createParams);
    resolvedPageId = created.id!;
    currentVersion = created.version!.number!;
  }

  // Fetch current attachments to build the map
  const attachmentsResult = await confluenceClient.contentAttachments.getAttachments({
    id: resolvedPageId,
  });

  type CurrentAttachments = Record<
    string,
    { filehash: string; attachmentId: string; collectionName: string }
  >;

  const currentAttachments: CurrentAttachments = {};
  for (const att of attachmentsResult.results ?? []) {
    const attTitle = att.title ?? '';
    const fileId = (att.extensions as any)?.fileId ?? '';
    const collectionName = (att.extensions as any)?.collectionName ?? '';
    if (attTitle) {
      currentAttachments[attTitle] = {
        filehash: (att.metadata as any)?.comment ?? '',
        attachmentId: fileId,
        collectionName,
      };
    }
  }

  // Build publisher functions
  const publisherFunctions = createPublisherFunctions(
    confluenceClient as unknown as any,
    stubAdaptor,
    resolvedPageId,
    title,
    currentAttachments
  );

  // Run ADF processing pipeline (renders diagrams via Kroki)
  const finalAdf = await executeADFProcessingPipeline(
    [
      new MermaidRendererPlugin(new KrokiMermaidRenderer(krokiClient)),
      ...KROKI_DIAGRAM_CONFIGS.map(
        (c) => new KrokiDiagramPlugin(c.type, krokiClient, c.format)
      ),
    ],
    adf as unknown as any,
    publisherFunctions
  );

  // Update the page with the final ADF
  const updateParams: Parameters<typeof confluenceClient.content.updateContent>[0] = {
    id: resolvedPageId,
    title,
    type: 'page',
    version: { number: currentVersion + 1 },
    body: {
      atlas_doc_format: {
        value: JSON.stringify(finalAdf),
        representation: 'atlas_doc_format',
      },
    },
  };

  if (parentId) {
    updateParams.ancestors = [{ id: parentId }];
  }

  await confluenceClient.content.updateContent(updateParams);

  const url = `${CONFLUENCE_BASE_URL}/wiki/spaces/${spaceKey}/pages/${resolvedPageId}`;

  return {
    isPreview: false,
    pageId: resolvedPageId,
    version: currentVersion + 1,
    diagramCount,
    url,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'mcp-markdown-to-confluence', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'markdown_preview',
      description:
        'Convert markdown to Confluence ADF and return a text preview. Does not publish to Confluence.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Markdown content to preview' },
          title: { type: 'string', description: 'Page title (used during ADF conversion)' },
        },
        required: ['markdown', 'title'],
      },
    },
    {
      name: 'markdown_publish',
      description:
        'Publish markdown to a Confluence page. By default runs a preview first; set skip_preview: true to publish immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Markdown content to publish' },
          title: { type: 'string', description: 'Confluence page title' },
          spaceKey: { type: 'string', description: 'Confluence space key (e.g. "ENG")' },
          pageId: {
            type: 'string',
            description: 'Existing page ID to update (omit to create a new page)',
          },
          parentId: {
            type: 'string',
            description: 'Parent page ID for new page creation',
          },
          skip_preview: {
            type: 'boolean',
            description: 'Set to true to skip preview and publish immediately',
            default: false,
          },
        },
        required: ['markdown', 'title', 'spaceKey'],
      },
    },
    {
      name: 'markdown_publish_file',
      description:
        'Read a markdown file from disk and publish it to Confluence. Frontmatter keys: connie-title / title, connie-space-key, connie-page-id.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the markdown file' },
          skip_preview: {
            type: 'boolean',
            description: 'Set to true to skip preview and publish immediately',
            default: false,
          },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'markdown_publish_directory',
      description:
        'Recursively scan a directory and publish markdown files as a Confluence page tree, ' +
        'mirroring the folder structure. Directories become parent pages; markdown files become child pages. ' +
        'Existing pages (with connie-page-id) are updated and reparented to match the directory structure.',
      inputSchema: {
        type: 'object',
        properties: {
          directoryPath: {
            type: 'string',
            description: 'Absolute path to the root directory',
          },
          spaceKey: {
            type: 'string',
            description: 'Confluence space key. Overrides file-level connie-space-key.',
          },
          rootPageId: {
            type: 'string',
            description: 'Existing Confluence page ID to use as the root parent. If omitted, a new root page is created.',
          },
          skip_preview: {
            type: 'boolean',
            description: 'Set to true to skip preview and publish immediately',
            default: false,
          },
          concurrency: {
            type: 'number',
            description: 'Maximum concurrent publishes per depth level (default: 5)',
            default: 5,
          },
        },
        required: ['directoryPath', 'spaceKey'],
      },
    },
  ],
}));

// Tool handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'markdown_preview') {
      const input = z
        .object({ markdown: z.string(), title: z.string() })
        .parse(args);

      const adf = parseMarkdownToADF(
        input.markdown,
        CONFLUENCE_BASE_URL
      ) as unknown as any;

      const diagramCount = countDiagramBlocks(adf);
      const previewText = renderADFDoc(adf as unknown as any);

      const lines: string[] = [previewText];
      if (diagramCount > 0) {
        lines.push(
          `\n[Note: ${diagramCount} diagram(s) detected — they will be rendered as images when published.]`
        );
      }

      return { content: [{ type: 'text', text: lines.join('') }] };
    }

    if (name === 'markdown_publish') {
      const input = z
        .object({
          markdown: z.string(),
          title: z.string(),
          spaceKey: z.string(),
          pageId: z.string().optional(),
          parentId: z.string().optional(),
          skip_preview: z.boolean().default(false),
        })
        .parse(args);

      const result = await publishMarkdown(
        input.markdown,
        input.title,
        input.spaceKey,
        input.pageId,
        input.parentId,
        input.skip_preview
      );

      if (result.isPreview) {
        const lines: string[] = ['=== PREVIEW ===\n', result.previewText ?? ''];
        if ((result.diagramCount ?? 0) > 0) {
          lines.push(
            `\n[Note: ${result.diagramCount} diagram(s) detected — they will be rendered when published.]`
          );
        }
        lines.push(
          '\n\nCall again with skip_preview: true to publish to Confluence.'
        );
        return { content: [{ type: 'text', text: lines.join('') }] };
      }

      return {
        content: [
          {
            type: 'text',
            text: [
              `Successfully published to Confluence.`,
              `Title: ${input.title}`,
              `Page ID: ${result.pageId}`,
              `Version: ${result.version}`,
              `Diagrams rendered: ${result.diagramCount}`,
              `URL: ${result.url}`,
            ].join('\n'),
          },
        ],
      };
    }

    if (name === 'markdown_publish_file') {
      const input = z
        .object({
          filePath: z.string(),
          skip_preview: z.boolean().default(false),
        })
        .parse(args);

      const raw = await readFile(input.filePath, 'utf-8');
      const parsed = matter(raw);

      const title: string =
        parsed.data['connie-title'] ?? parsed.data['title'] ?? '';
      const spaceKey: string = parsed.data['connie-space-key'] ?? '';
      const pageId: string | undefined = parsed.data['connie-page-id']
        ? String(parsed.data['connie-page-id'])
        : undefined;

      if (!title) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Error: Missing page title. Set "connie-title" or "title" in frontmatter.',
            },
          ],
        };
      }

      if (!spaceKey) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Error: Missing space key. Set "connie-space-key" in frontmatter.',
            },
          ],
        };
      }

      const result = await publishMarkdown(
        parsed.content,
        title,
        spaceKey,
        pageId,
        undefined,
        input.skip_preview
      );

      if (result.isPreview) {
        const lines: string[] = [
          `File: ${input.filePath}\n`,
          '=== PREVIEW ===\n',
          result.previewText ?? '',
        ];
        if ((result.diagramCount ?? 0) > 0) {
          lines.push(
            `\n[Note: ${result.diagramCount} diagram(s) detected — they will be rendered when published.]`
          );
        }
        lines.push(
          '\n\nCall again with skip_preview: true to publish to Confluence.'
        );
        return { content: [{ type: 'text', text: lines.join('') }] };
      }

      return {
        content: [
          {
            type: 'text',
            text: [
              `Successfully published "${title}" to Confluence.`,
              `File: ${input.filePath}`,
              `Page ID: ${result.pageId}`,
              `Version: ${result.version}`,
              `Diagrams rendered: ${result.diagramCount}`,
              `URL: ${result.url}`,
            ].join('\n'),
          },
        ],
      };
    }

    if (name === 'markdown_publish_directory') {
      const input = z
        .object({
          directoryPath: z.string(),
          spaceKey: z.string(),
          rootPageId: z.string().optional(),
          skip_preview: z.boolean().default(false),
          concurrency: z.number().int().min(1).max(20).default(5),
        })
        .parse(args);

      // Scan directory tree
      const { nodes, skipped } = await scanDirectoryTree(
        input.directoryPath,
        input.spaceKey
      );

      if (nodes.length === 0 && skipped.length === 0) {
        return {
          content: [{ type: 'text', text: `No files found in ${input.directoryPath}` }],
        };
      }

      // Preview mode
      if (!input.skip_preview) {
        const rootTitle = input.rootPageId
          ? `(existing page: ${input.rootPageId})`
          : `"${basename(input.directoryPath)}" (will be created)`;

        const lines: string[] = [
          `=== DIRECTORY TREE PREVIEW ===`,
          `Directory: ${input.directoryPath}`,
          `Space: ${input.spaceKey}`,
          `Root page: ${rootTitle}`,
          `Total pages: ${nodes.length + (input.rootPageId ? 0 : 1)}`,
          '',
          '--- Page tree ---',
        ];

        // Build tree visualization
        const maxDepth = nodes.reduce((max, n) => Math.max(max, n.depth), 0);
        for (let d = 0; d <= maxDepth; d++) {
          for (const node of nodes.filter((n) => n.depth === d)) {
            const indent = '  '.repeat(d + 1);
            const suffix = node.isDirectory ? '/' : '';
            const pageInfo = node.markdownFile?.pageId
              ? `update: ${node.markdownFile.pageId}`
              : 'new page';
            let diagrams = '';
            if (node.markdownFile) {
              const adf = parseMarkdownToADF(node.markdownFile.content, CONFLUENCE_BASE_URL) as any;
              const count = countDiagramBlocks(adf);
              if (count > 0) diagrams = `, ${count} diagram(s)`;
            }
            const label = node.isDirectory && !node.markdownFile ? 'placeholder' : pageInfo;
            lines.push(`${indent}${node.title}${suffix} (${label}${diagrams})`);
          }
        }

        if (skipped.length > 0) {
          lines.push('', '--- Skipped files ---');
          for (const s of skipped) {
            lines.push(`  ${basename(s.filePath)}: ${s.reason}`);
          }
        }

        lines.push('', `Call again with skip_preview: true to publish.`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // Publish mode — process level by level
      const limit = pLimit(input.concurrency);

      interface FileResult {
        relativePath: string;
        title: string;
        success: boolean;
        isDirectory: boolean;
        pageId?: string;
        version?: number;
        diagramCount?: number;
        url?: string;
        error?: string;
      }

      // Create or resolve root page
      let rootPageId = input.rootPageId;
      const allResults: FileResult[] = [];

      if (!rootPageId) {
        try {
          const rootResult = await publishMarkdown(
            '',
            basename(input.directoryPath),
            input.spaceKey,
            undefined,
            undefined,
            true
          );
          rootPageId = rootResult.pageId;
          allResults.push({
            relativePath: '.',
            title: basename(input.directoryPath),
            success: true,
            isDirectory: true,
            pageId: rootResult.pageId,
            version: rootResult.version,
            url: rootResult.url,
          });
        } catch (err: unknown) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Error creating root page: ${err instanceof Error ? err.message : String(err)}`,
            }],
          };
        }
      }

      // Build a map from relativePath to node for parent lookups
      const nodeMap = new Map<string, DirectoryNode>();
      for (const node of nodes) {
        nodeMap.set(node.relativePath, node);
      }

      // Group by depth and process level by level
      const maxDepth = nodes.reduce((max, n) => Math.max(max, n.depth), 0);

      for (let depth = 0; depth <= maxDepth; depth++) {
        const levelNodes = nodes.filter((n) => n.depth === depth);

        const levelResults = await Promise.all(
          levelNodes.map((node) =>
            limit(async (): Promise<FileResult> => {
              // Determine parent page ID
              let parentId: string | undefined;
              if (node.parentRelativePath === null) {
                parentId = rootPageId;
              } else {
                const parentNode = nodeMap.get(node.parentRelativePath);
                parentId = parentNode?.resolvedPageId;
              }

              if (!parentId) {
                return {
                  relativePath: node.relativePath,
                  title: node.title,
                  success: false,
                  isDirectory: node.isDirectory,
                  error: 'Parent page was not created (parent failed)',
                };
              }

              try {
                const content = node.markdownFile?.content ?? '';
                const pageId = node.markdownFile?.pageId;

                const result = await publishMarkdown(
                  content,
                  node.title,
                  input.spaceKey,
                  pageId,
                  parentId,
                  true
                );

                // Store resolved page ID for children
                node.resolvedPageId = result.pageId;

                return {
                  relativePath: node.relativePath,
                  title: node.title,
                  success: true,
                  isDirectory: node.isDirectory,
                  pageId: result.pageId,
                  version: result.version,
                  diagramCount: result.diagramCount,
                  url: result.url,
                };
              } catch (err: unknown) {
                return {
                  relativePath: node.relativePath,
                  title: node.title,
                  success: false,
                  isDirectory: node.isDirectory,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            })
          )
        );

        allResults.push(...levelResults);
      }

      // Second pass: resolve wiki links [[Page Name]] and [[Page Name#Heading]]
      // Build title → URL map from all successfully published pages
      const titleToUrl = new Map<string, string>();
      for (const r of allResults) {
        if (r.success && r.url) {
          titleToUrl.set(r.title, r.url);
        }
      }

      // Find nodes with wiki links that need re-publishing
      const nodesWithLinks = nodes.filter(
        (n) => n.markdownFile && hasWikiLinks(n.markdownFile.content) && n.resolvedPageId
      );

      if (nodesWithLinks.length > 0 && titleToUrl.size > 0) {
        const linkResults = await Promise.all(
          nodesWithLinks.map((node) =>
            limit(async () => {
              try {
                const resolvedMarkdown = resolveWikiLinks(
                  node.markdownFile!.content,
                  titleToUrl
                );
                const result = await publishMarkdown(
                  resolvedMarkdown,
                  node.title,
                  input.spaceKey,
                  node.resolvedPageId,
                  undefined, // don't reparent on second pass
                  true
                );
                return { relativePath: node.relativePath, title: node.title, success: true, version: result.version };
              } catch {
                return { relativePath: node.relativePath, title: node.title, success: false };
              }
            })
          )
        );

        const linkedCount = linkResults.filter((r) => r.success).length;
        if (linkedCount > 0) {
          // Update versions in allResults
          for (const lr of linkResults) {
            if (lr.success && lr.version) {
              const existing = allResults.find((r) => r.relativePath === lr.relativePath);
              if (existing) existing.version = lr.version;
            }
          }
        }
      }

      // Build summary
      const succeeded = allResults.filter((r) => r.success);
      const failed = allResults.filter((r) => !r.success);

      const lines: string[] = [
        `=== DIRECTORY PUBLISH RESULTS ===`,
        `Directory: ${input.directoryPath}`,
        `Space: ${input.spaceKey}`,
        `Succeeded: ${succeeded.length} | Failed: ${failed.length} | Skipped: ${skipped.length}` +
          (nodesWithLinks.length > 0 ? ` | Wiki links resolved: ${nodesWithLinks.length} page(s)` : ''),
        '',
      ];

      if (succeeded.length > 0) {
        lines.push('--- Succeeded ---');
        for (const r of succeeded) {
          const type = r.isDirectory ? ' (folder)' : '';
          lines.push(`  "${r.title}"${type}`);
          lines.push(`    Page ID: ${r.pageId} | Version: ${r.version}${r.diagramCount ? ` | Diagrams: ${r.diagramCount}` : ''} | URL: ${r.url}`);
        }
      }

      if (failed.length > 0) {
        lines.push('', '--- Failed ---');
        for (const r of failed) {
          lines.push(`  "${r.title}" (${r.relativePath})`);
          lines.push(`    Error: ${r.error}`);
        }
      }

      if (skipped.length > 0) {
        lines.push('', '--- Skipped (invalid frontmatter) ---');
        for (const s of skipped) {
          lines.push(`  ${basename(s.filePath)}: ${s.reason}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return {
      isError: true,
      content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${message}` }],
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
