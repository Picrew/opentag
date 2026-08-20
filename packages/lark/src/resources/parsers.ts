import { OfficeParser, type OfficeParserAST, type SupportedFileType } from "officeparser";
import type { FeishuDownloadedResource } from "./types.js";

export const DEFAULT_FEISHU_PARSE_LIMIT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_FEISHU_PARSE_TEXT_LIMIT = 500_000;
export const DEFAULT_FEISHU_PARSE_TIMEOUT_MS = 30_000;

export type FeishuParsedFile = {
  text: string;
  fileName?: string;
  mediaType?: string;
  parser: "text" | "office";
  truncated: boolean;
};

type OfficeParse = (
  bytes: Uint8Array,
  options: {
    fileType?: SupportedFileType;
    ocr: false;
    extractAttachments: false;
    includeRawContent: false;
    abortSignal: AbortSignal;
    decompressionLimits: { maxUncompressedBytes: number; maxZipEntries: number; maxTableCells: number };
  }
) => Promise<Pick<OfficeParserAST, "toText">>;

const TEXT_EXTENSIONS = new Set(["csv", "json", "log", "md", "markdown", "text", "tsv", "txt", "xml"]);
const OFFICE_EXTENSIONS = new Set<SupportedFileType>(["csv", "docx", "odp", "ods", "odt", "pdf", "pptx", "rtf", "xlsx"]);
const TEXT_MEDIA_TYPES = new Set([
  "application/csv",
  "application/json",
  "application/xml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/xml"
]);

function extension(fileName: string | undefined): string | undefined {
  const match = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/u);
  return match?.[1];
}

function normalizedMediaType(mediaType: string | undefined): string | undefined {
  return mediaType?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function truncate(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { text, truncated: false };
  return { text: text.slice(0, maxCharacters), truncated: true };
}

function isTextFile(ext: string | undefined, mediaType: string | undefined): boolean {
  return (ext !== undefined && TEXT_EXTENSIONS.has(ext))
    || (mediaType !== undefined && (mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType)));
}

function officeFileType(ext: string | undefined): SupportedFileType | undefined {
  return ext && OFFICE_EXTENSIONS.has(ext as SupportedFileType) ? ext as SupportedFileType : undefined;
}

export async function parseFeishuDownloadedResource(
  resource: FeishuDownloadedResource,
  options: {
    maxBytes?: number;
    maxCharacters?: number;
    timeoutMs?: number;
    parseOffice?: OfficeParse;
  } = {}
): Promise<FeishuParsedFile> {
  const maxBytes = Math.max(options.maxBytes ?? DEFAULT_FEISHU_PARSE_LIMIT_BYTES, 1);
  const maxCharacters = Math.max(options.maxCharacters ?? DEFAULT_FEISHU_PARSE_TEXT_LIMIT, 1);
  if (resource.bytes.byteLength > maxBytes) {
    throw new Error(`Feishu resource exceeds the configured ${maxBytes}-byte parsing limit.`);
  }

  const ext = extension(resource.fileName);
  const mediaType = normalizedMediaType(resource.mediaType);
  let text: string;
  let parser: FeishuParsedFile["parser"];
  if (isTextFile(ext, mediaType)) {
    text = new TextDecoder("utf-8", { fatal: false }).decode(resource.bytes);
    parser = "text";
  } else {
    const fileType = officeFileType(ext);
    const supportedByMediaType = mediaType === "application/pdf"
      || mediaType?.includes("officedocument") === true
      || mediaType?.includes("opendocument") === true
      || mediaType === "application/rtf";
    if (!fileType && !supportedByMediaType) {
      throw new Error(`Unsupported Feishu attachment type: ${resource.fileName ?? resource.mediaType ?? "unknown"}.`);
    }
    const ast = await (options.parseOffice ?? OfficeParser.parseOffice)(resource.bytes, {
      ...(fileType ? { fileType } : {}),
      ocr: false,
      extractAttachments: false,
      includeRawContent: false,
      abortSignal: AbortSignal.timeout(Math.max(options.timeoutMs ?? DEFAULT_FEISHU_PARSE_TIMEOUT_MS, 1)),
      decompressionLimits: {
        maxUncompressedBytes: 128 * 1024 * 1024,
        maxZipEntries: 5_000,
        maxTableCells: 500_000
      }
    });
    text = ast.toText();
    parser = "office";
  }

  const result = truncate(text, maxCharacters);
  return {
    ...result,
    parser,
    ...(resource.fileName ? { fileName: resource.fileName } : {}),
    ...(resource.mediaType ? { mediaType: resource.mediaType } : {})
  };
}
