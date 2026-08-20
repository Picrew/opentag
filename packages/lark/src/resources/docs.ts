import type { FeishuOpenApiClient } from "./client.js";
import { parseFeishuResourceReference } from "./urls.js";
import type { FeishuResource } from "./types.js";

export type FeishuDocumentBlock = Record<string, unknown> & {
  block_id?: string;
  block_type?: number;
  parent_id?: string;
  children?: string[];
};

export type FeishuDocumentBlocks = {
  resource: FeishuResource;
  blocks: FeishuDocumentBlock[];
};

type DocxRawContentResponse = {
  content?: string;
  revision_id?: number;
};

type DocxBlockPageResponse = {
  items?: FeishuDocumentBlock[];
  has_more?: boolean;
  page_token?: string;
};

function documentResource(input: {
  token: string;
  sourceUrl?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}): FeishuResource {
  return {
    id: input.token,
    type: "document",
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    metadata: { token: input.token, ...input.metadata }
  };
}

export function createFeishuDocumentReader(client: FeishuOpenApiClient) {
  return {
    async readDocument(urlOrId: string): Promise<FeishuResource> {
      const reference = parseFeishuResourceReference(urlOrId, "document");
      if (reference.type !== "document") {
        throw new Error(`Expected a Feishu document reference, received ${reference.type}.`);
      }
      const data = await client.requestJson<DocxRawContentResponse>(
        `/open-apis/docx/v1/documents/${encodeURIComponent(reference.token)}/raw_content`
      );
      return documentResource({
        token: reference.token,
        ...(reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {}),
        text: data.content ?? "",
        ...(data.revision_id !== undefined ? { metadata: { revisionId: data.revision_id } } : {})
      });
    },

    async readDocumentBlocks(urlOrId: string, options: { pageSize?: number; maxBlocks?: number } = {}): Promise<FeishuDocumentBlocks> {
      const reference = parseFeishuResourceReference(urlOrId, "document");
      if (reference.type !== "document") {
        throw new Error(`Expected a Feishu document reference, received ${reference.type}.`);
      }
      const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 500);
      const maxBlocks = Math.max(options.maxBlocks ?? 5_000, 1);
      const blocks: FeishuDocumentBlock[] = [];
      let pageToken: string | undefined;

      do {
        const page = await client.requestJson<DocxBlockPageResponse>(
          `/open-apis/docx/v1/documents/${encodeURIComponent(reference.token)}/blocks`,
          {
            query: {
              page_size: Math.min(pageSize, maxBlocks - blocks.length),
              page_token: pageToken,
              document_revision_id: -1
            }
          }
        );
        blocks.push(...(page.items ?? []).slice(0, maxBlocks - blocks.length));
        pageToken = page.has_more && blocks.length < maxBlocks ? page.page_token : undefined;
        if (page.has_more && !pageToken && blocks.length < maxBlocks) {
          throw new Error("Feishu document block pagination reported more data without a page token.");
        }
      } while (pageToken && blocks.length < maxBlocks);

      return {
        resource: documentResource({
          token: reference.token,
          ...(reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {}),
          metadata: { blockCount: blocks.length, truncated: blocks.length >= maxBlocks }
        }),
        blocks
      };
    }
  };
}

export type FeishuDocumentReader = ReturnType<typeof createFeishuDocumentReader>;
