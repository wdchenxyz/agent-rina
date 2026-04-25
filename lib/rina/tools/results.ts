/** Structured result returned by tools that want the delivery layer to upload a file. */
export interface FileUploadResult {
  _type: "file-upload";
  caption: string;
  filename: string;
  mimeType: string;
  /** Base64-encoded file data */
  dataBase64: string;
}

export interface ToolCitation {
  title?: string;
  url: string;
}

export interface RinaToolResult {
  _type: "rina-tool-result";
  ok: boolean;
  summary: string;
  data?: unknown;
  files?: FileUploadResult[];
  citations?: ToolCitation[];
  warnings?: string[];
  metrics?: {
    elapsedMs?: number;
  };
}

export function toolResult(
  input: Omit<RinaToolResult, "_type">,
): RinaToolResult {
  return { _type: "rina-tool-result", ...input };
}

export function isFileUploadResult(value: unknown): value is FileUploadResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as FileUploadResult)._type === "file-upload"
  );
}

export function isRinaToolResult(value: unknown): value is RinaToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RinaToolResult)._type === "rina-tool-result"
  );
}

export function extractFileUploads(value: unknown): FileUploadResult[] {
  if (isFileUploadResult(value)) return [value];
  if (isRinaToolResult(value)) return value.files ?? [];

  if (
    typeof value === "object" &&
    value !== null &&
    "files" in value &&
    Array.isArray((value as { files: unknown }).files)
  ) {
    return (value as { files: unknown[] }).files.filter(isFileUploadResult);
  }

  return [];
}

export function toolResultToModelText(output: string | RinaToolResult): string {
  if (typeof output === "string") return output;

  const parts = [output.summary];

  if (output.citations?.length) {
    parts.push(
      `Sources:\n${output.citations
        .map((citation) =>
          citation.title
            ? `- ${citation.title}: ${citation.url}`
            : `- ${citation.url}`,
        )
        .join("\n")}`,
    );
  }

  if (output.warnings?.length) {
    parts.push(`Warnings:\n${output.warnings.map((w) => `- ${w}`).join("\n")}`);
  }

  if (output.files?.length) {
    parts.push(`Files posted to chat: ${output.files.map((f) => f.filename).join(", ")}`);
  }

  return parts.join("\n\n");
}
