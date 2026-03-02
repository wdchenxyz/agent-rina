import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { BotThread } from "../types";

const ARTIFACTS_DIR = path.resolve("artifacts");

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 500;
const DEFAULT_BACKGROUND = "#ffffff";

/**
 * Creates the createChart tool, which renders a Vega-Lite spec to PNG
 * and posts it to the chat thread.
 *
 * Pipeline:
 *   1. Merge sensible defaults into the spec (width, height, background)
 *   2. vega-lite compile → Vega spec
 *   3. vega View.toSVG() → SVG string (pure JS, no native deps)
 *   4. @resvg/resvg-js → PNG buffer (Rust prebuilt, no system deps)
 *   5. Save PNG to artifacts/
 *   6. Post PNG to chat via thread.post()
 */
export function createChartTools(thread: BotThread) {
  const createChart = tool({
    description:
      "Create a chart or data visualization from a Vega-Lite specification. " +
      "Renders the chart as a PNG image, saves it to artifacts/, and posts it to the chat. " +
      "Use this when users ask you to plot, chart, graph, or visualize data. " +
      "Provide a valid Vega-Lite v5 JSON spec as the 'spec' parameter.",
    inputSchema: z.object({
      spec: z
        .string()
        .describe(
          "A Vega-Lite v5 specification as a JSON string. Must include at least 'mark', 'encoding', and 'data'. " +
          'Example: \'{"mark":"bar","data":{"values":[{"x":"A","y":28}]},"encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}\'',
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "Optional filename for the chart (without extension). Defaults to 'chart_<timestamp>'. " +
          "The .png extension is added automatically.",
        ),
    }),
    execute: async ({ spec: specJson, filename }) => {
      try {
        // Parse the JSON spec string
        let spec: Record<string, unknown>;
        try {
          spec = JSON.parse(specJson);
        } catch {
          return "Failed to create chart: invalid JSON in spec parameter.";
        }

        // Dynamic imports — vega/vega-lite are ESM-heavy, and @resvg/resvg-js
        // ships native binaries, so lazy-loading avoids startup cost.
        const [vegaLiteModule, vegaModule, resvgModule] = await Promise.all([
          import("vega-lite"),
          import("vega"),
          import("@resvg/resvg-js"),
        ]);

        // Apply defaults if not present in spec
        const fullSpec = {
          $schema: "https://vega.github.io/schema/vega-lite/v5.json",
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          background: DEFAULT_BACKGROUND,
          ...spec,
        };

        // Compile Vega-Lite → Vega
        const compiled = vegaLiteModule.compile(
          fullSpec as Parameters<typeof vegaLiteModule.compile>[0],
        );

        // Render Vega → SVG
        const view = new vegaModule.View(
          vegaModule.parse(compiled.spec),
          { renderer: "none" },
        );
        const svg = await view.toSVG();
        view.finalize();

        // Convert SVG → PNG
        const resvg = new resvgModule.Resvg(svg, {
          fitTo: { mode: "width" as const, value: fullSpec.width as number },
          background: DEFAULT_BACKGROUND,
        });
        const pngData = resvg.render();
        const pngBuffer = pngData.asPng();

        // Determine filename
        const baseName =
          filename?.replace(/\.png$/i, "") ||
          `chart_${Date.now()}`;
        const pngFilename = `${baseName}.png`;

        // Save to artifacts/
        await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
        const outputPath = path.join(ARTIFACTS_DIR, pngFilename);
        await fs.writeFile(outputPath, pngBuffer);

        // Post to chat — markdown MUST be non-empty because:
        // 1. The chat SDK's createSentMessage requires a text field (markdown/raw/ast/card)
        // 2. Slack's chat.postMessage rejects empty text
        // The Slack adapter uploads files first, then posts the markdown as a separate message.
        await thread.post({
          markdown: pngFilename,
          files: [{ data: Buffer.from(pngBuffer), filename: pngFilename, mimeType: "image/png" }],
        });

        return `Chart rendered and posted: ${pngFilename} (${(pngBuffer.length / 1024).toFixed(1)} KB)`;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[rina:chart] createChart failed: ${message}`, error);
        return `Failed to create chart: ${message}`;
      }
    },
  });

  return { createChart };
}
