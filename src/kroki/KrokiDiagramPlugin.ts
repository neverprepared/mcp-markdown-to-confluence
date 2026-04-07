import { filter, traverse } from '@atlaskit/adf-utils/traverse';
import type { ADFEntity } from '@atlaskit/adf-utils/types';
import type { JSONDocNode } from '@atlaskit/editor-json-transformer';
import SparkMD5 from 'spark-md5';
import type { ADFProcessingPlugin, PublisherFunctions } from '@markdown-confluence/lib';
import type { KrokiClient } from './KrokiClient.js';

interface ChartData {
  name: string;
  data: string;
}

interface UploadedImage {
  id: string;
  collection: string;
  width: number;
  height: number;
}

function getDiagramFileName(diagramType: string, content: string | undefined, outputFormat: string) {
  const text = content ?? `${diagramType} placeholder`;
  const hash = SparkMD5.hash(text);
  const ext = outputFormat === 'png' ? 'png' : 'svg';
  const uploadFilename = `RenderedKrokiChart-${diagramType}-${hash}.${ext}`;
  return { uploadFilename, text };
}

export class KrokiDiagramPlugin
  implements ADFProcessingPlugin<ChartData[], Record<string, UploadedImage | null>>
{
  constructor(
    private diagramType: string,
    private client: KrokiClient,
    private outputFormat: string = 'svg'
  ) {}

  extract(adf: JSONDocNode): ChartData[] {
    const nodes = filter(
      adf as unknown as ADFEntity,
      (node) =>
        node.type === 'codeBlock' &&
        (node.attrs || {} as Record<string, unknown>)?.['language'] === this.diagramType
    );

    const charts = new Set(
      nodes.map((node) => {
        const details = getDiagramFileName(
          this.diagramType,
          node?.content?.[0]?.text,
          this.outputFormat
        );
        return {
          name: details.uploadFilename,
          data: details.text,
        } as ChartData;
      })
    );

    return Array.from(charts);
  }

  async transform(
    charts: ChartData[],
    supportFunctions: PublisherFunctions
  ): Promise<Record<string, UploadedImage | null>> {
    if (charts.length === 0) {
      return {};
    }

    // Render all diagrams in parallel, then upload all results in parallel.
    // Previously uploads were sequential (N+1); now both phases are concurrent.
    const rendered = await Promise.all(
      charts.map(async (chart) => {
        const buffer = await this.client.renderDiagram(
          this.diagramType,
          chart.data,
          this.outputFormat
        );
        return [chart.name, buffer] as const;
      })
    );

    const uploaded = await Promise.all(
      rendered.map(async ([name, buffer]) => {
        const image = await supportFunctions.uploadBuffer(name, buffer);
        return [name, image] as const;
      })
    );

    const imageMap: Record<string, UploadedImage | null> = {};
    for (const [name, image] of uploaded) {
      imageMap[name] = image;
    }
    return imageMap;
  }

  load(
    adf: JSONDocNode,
    imageMap: Record<string, UploadedImage | null>
  ): JSONDocNode {
    let afterAdf = adf as unknown as ADFEntity;

    afterAdf =
      traverse(afterAdf, {
        codeBlock: (node, _parent) => {
          if (node?.attrs?.['language'] === this.diagramType) {
            const content = node?.content?.[0]?.text;
            if (!content) {
              return;
            }

            const filename = getDiagramFileName(this.diagramType, content, this.outputFormat);
            if (!imageMap[filename.uploadFilename]) {
              return;
            }

            const mappedImage = imageMap[filename.uploadFilename];
            if (mappedImage) {
              node.type = 'mediaSingle';
              node.attrs['layout'] = 'center';
              if (node.content) {
                node.content = [
                  {
                    type: 'media',
                    attrs: {
                      type: 'file',
                      collection: mappedImage.collection,
                      id: mappedImage.id,
                      width: mappedImage.width,
                      height: mappedImage.height,
                    },
                  },
                ];
              }
              delete node.attrs['language'];
              return node;
            }
          }
          return;
        },
      }) || afterAdf;

    return afterAdf as unknown as JSONDocNode;
  }
}
