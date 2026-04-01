import type { ChartData, MermaidRenderer } from '@markdown-confluence/lib';
import { KrokiClient } from './KrokiClient.js';

export class KrokiMermaidRenderer implements MermaidRenderer {
  constructor(private client: KrokiClient) {}

  async captureMermaidCharts(
    charts: ChartData[]
  ): Promise<Map<string, Buffer>> {
    const results = await Promise.all(
      charts.map(async (chart) => {
        const buffer = await this.client.renderDiagram('mermaid', chart.data);
        return [chart.name, buffer] as const;
      })
    );

    return new Map(results);
  }
}
