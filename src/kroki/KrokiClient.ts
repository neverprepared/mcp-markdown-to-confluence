export class KrokiClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8371') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async renderDiagram(
    diagramType: string,
    source: string,
    outputFormat: string = 'png'
  ): Promise<Buffer> {
    const url = `${this.baseUrl}/${diagramType}/${outputFormat}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: source,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Kroki render failed for ${diagramType} (${response.status}): ${body}`
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
