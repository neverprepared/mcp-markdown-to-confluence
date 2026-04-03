import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ConfluenceClient } from 'confluence.js';
import matter from 'gray-matter';
import { readFile } from 'fs/promises';

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

const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL ?? '';
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
