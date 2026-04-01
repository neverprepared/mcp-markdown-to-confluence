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

function getDiagramFileName(diagramType: string, content: string | undefined) {
  const text = content ?? `${diagramType} placeholder`;
  const hash = SparkMD5.hash(text);
  const uploadFilename = `RenderedKrokiChart-${diagramType}-${hash}.png`;
  return { uploadFilename, text };
}

export class KrokiDiagramPlugin
  implements ADFProcessingPlugin<ChartData[], Record<string, UploadedImage | null>>
{
  constructor(
    private diagramType: string,
    private client: KrokiClient,
    private outputFormat: string = 'png'
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
          node?.content?.at(0)?.text
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
    let imageMap: Record<string, UploadedImage | null> = {};

    if (charts.length === 0) {
      return imageMap;
    }

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

    for (const [name, buffer] of rendered) {
      const uploaded = await supportFunctions.uploadBuffer(name, buffer);
      imageMap = { ...imageMap, [name]: uploaded };
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
            const content = node?.content?.at(0)?.text;
            if (!content) {
              return;
            }

            const filename = getDiagramFileName(this.diagramType, content);
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
