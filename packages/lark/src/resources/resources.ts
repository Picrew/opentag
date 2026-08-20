import { createFeishuBitableReader } from "./bitable.js";
import type { FeishuOpenApiClient } from "./client.js";
import { createFeishuDocumentReader } from "./docs.js";
import { createFeishuDriveReader } from "./drive.js";
import { createFeishuImReader } from "./im.js";
import { parseFeishuDownloadedResource } from "./parsers.js";
import { createFeishuSheetReader } from "./sheets.js";
import type { FeishuResource, FeishuResourceReference } from "./types.js";
import { parseFeishuResourceReference } from "./urls.js";
import { createFeishuWikiReader } from "./wiki.js";

function referenceFrom(input: string | FeishuResourceReference | FeishuResource): FeishuResourceReference {
  if (typeof input === "string") return parseFeishuResourceReference(input);
  if ("metadata" in input) {
    return { token: input.metadata.token ?? input.id, type: input.type, ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}) };
  }
  return input;
}

function isUnsupportedAttachment(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unsupported Feishu attachment type:");
}

export function createFeishuTools(client: FeishuOpenApiClient) {
  const documents = createFeishuDocumentReader(client);
  const drive = createFeishuDriveReader(client);
  const sheets = createFeishuSheetReader(client);
  const bitable = createFeishuBitableReader(client);
  const im = createFeishuImReader(client);

  async function readFile(input: FeishuResourceReference | FeishuResource): Promise<FeishuResource> {
    const reference = referenceFrom(input);
    const downloaded = await drive.downloadDriveFile(reference.token);
    try {
      const parsed = await parseFeishuDownloadedResource(downloaded);
      return {
        id: reference.token,
        type: "file",
        ...(parsed.fileName ? { title: parsed.fileName } : {}),
        text: parsed.text,
        ...(reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {}),
        metadata: {
          token: reference.token,
          parser: parsed.parser,
          truncated: parsed.truncated,
          size: downloaded.bytes.byteLength,
          ...(parsed.mediaType ? { mediaType: parsed.mediaType } : {})
        }
      };
    } catch (error) {
      if (!isUnsupportedAttachment(error)) throw error;
      return {
        id: reference.token,
        type: "file",
        ...(downloaded.fileName ? { title: downloaded.fileName } : {}),
        ...(reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {}),
        metadata: {
          token: reference.token,
          size: downloaded.bytes.byteLength,
          textExtractable: false,
          ...(downloaded.mediaType ? { mediaType: downloaded.mediaType } : {})
        }
      };
    }
  }

  async function readMessage(input: FeishuResourceReference | FeishuResource): Promise<FeishuResource> {
    const reference = referenceFrom(input);
    const message = "metadata" in input ? input : await im.getMessage(reference.token);
    const fileKey = typeof message.metadata.fileKey === "string" ? message.metadata.fileKey : undefined;
    const resourceType = message.metadata.resourceType === "image" ? "image" : "file";
    if (!fileKey) return message;
    const downloaded = await im.downloadMessageResource(message.id, fileKey, resourceType);
    try {
      const parsed = await parseFeishuDownloadedResource(downloaded);
      return {
        ...message,
        ...(parsed.fileName && !message.title ? { title: parsed.fileName } : {}),
        text: parsed.text,
        metadata: {
          ...message.metadata,
          parser: parsed.parser,
          truncated: parsed.truncated,
          size: downloaded.bytes.byteLength,
          ...(parsed.mediaType ? { mediaType: parsed.mediaType } : {})
        }
      };
    } catch (error) {
      if (!isUnsupportedAttachment(error)) throw error;
      return {
        ...message,
        metadata: {
          ...message.metadata,
          size: downloaded.bytes.byteLength,
          textExtractable: false,
          ...(downloaded.mediaType ? { mediaType: downloaded.mediaType } : {})
        }
      };
    }
  }

  async function readResource(input: string | FeishuResourceReference | FeishuResource): Promise<FeishuResource> {
    const reference = referenceFrom(input);
    switch (reference.type) {
      case "document": return documents.readDocument(reference.sourceUrl ?? reference.token);
      case "wiki": return wiki.readWikiNode(reference.token);
      case "sheet": return sheets.readSheet(reference.token);
      case "bitable": return bitable.readBitable(reference.token);
      case "file": return readFile(input as FeishuResourceReference | FeishuResource);
      case "message": return readMessage(input as FeishuResourceReference | FeishuResource);
      case "folder": {
        const page = await drive.listDriveFolder(reference.token);
        return {
          id: reference.token,
          type: "folder",
          text: JSON.stringify(page.items, null, 2),
          ...(reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {}),
          metadata: { token: reference.token, childCount: page.items.length, hasMore: page.hasMore, pageToken: page.pageToken }
        };
      }
    }
  }

  const wiki = createFeishuWikiReader(client, { readResource });
  return {
    readResource,
    readDocument: documents.readDocument,
    readDocumentBlocks: documents.readDocumentBlocks,
    listDrive: drive.listDriveFolder,
    walkDrive: drive.walkDrive,
    listWikiSpaces: wiki.listWikiSpaces,
    listWikiNodes: wiki.listWikiNodes,
    readWikiNode: wiki.readWikiNode,
    getChatHistory: im.getChatHistory,
    getMessage: im.getMessage,
    downloadMessageFile: im.downloadMessageResource
  };
}

export type FeishuTools = ReturnType<typeof createFeishuTools>;
