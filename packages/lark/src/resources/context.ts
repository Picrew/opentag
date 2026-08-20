import type { OpenTagChannelAttachmentRef } from "@opentag/core";
import type { LarkResolvedResourceContext } from "../normalize.js";
import type { FeishuTools } from "./resources.js";
import { parseFeishuDownloadedResource } from "./parsers.js";
import { findFeishuResourceReferences } from "./urls.js";

export const DEFAULT_FEISHU_CONTEXT_RESOURCE_LIMIT = 10;
export const DEFAULT_FEISHU_CONTEXT_CHARACTER_LIMIT = 500_000;
export const DEFAULT_FEISHU_ATTACHMENT_CHARACTER_LIMIT = 200_000;

type ContextTools = Pick<FeishuTools, "readResource" | "downloadMessageFile">;

function attachmentResourceType(attachment: OpenTagChannelAttachmentRef): "file" | "image" {
  return attachment.kind === "image" ? "image" : "file";
}

export function createFeishuResourceContextResolver(input: {
  tools: ContextTools;
  maxResources?: number;
  maxCharacters?: number;
  maxAttachmentCharacters?: number;
}) {
  const maxResources = Math.max(input.maxResources ?? DEFAULT_FEISHU_CONTEXT_RESOURCE_LIMIT, 1);
  const maxCharacters = Math.max(input.maxCharacters ?? DEFAULT_FEISHU_CONTEXT_CHARACTER_LIMIT, 1);
  const maxAttachmentCharacters = Math.max(
    input.maxAttachmentCharacters ?? DEFAULT_FEISHU_ATTACHMENT_CHARACTER_LIMIT,
    1
  );

  return async function resolveResourceContext(message: {
    messageId: string;
    text: string;
    attachments: OpenTagChannelAttachmentRef[];
  }): Promise<LarkResolvedResourceContext[]> {
    const context: LarkResolvedResourceContext[] = [];
    let characters = 0;

    function append(resource: LarkResolvedResourceContext): void {
      if (context.length >= maxResources || characters >= maxCharacters || !resource.text) return;
      const text = resource.text.slice(0, maxCharacters - characters);
      if (!text) return;
      context.push({ ...resource, text });
      characters += text.length;
    }

    for (const reference of findFeishuResourceReferences(message.text).slice(0, maxResources)) {
      if (context.length >= maxResources || characters >= maxCharacters) break;
      try {
        const resource = await input.tools.readResource(reference);
        if (resource.text) {
          append({
            id: `${resource.type}:${resource.id}`,
            title: resource.title ?? `Feishu ${resource.type}`,
            text: resource.text,
            ...(resource.sourceUrl ?? reference.sourceUrl ? { sourceUrl: resource.sourceUrl ?? reference.sourceUrl } : {})
          });
        }
      } catch {
        // The MCP tool remains available for an explicit retry and can surface its structured API error.
      }
    }

    for (const attachment of message.attachments) {
      if (context.length >= maxResources || characters >= maxCharacters) break;
      try {
        const downloaded = await input.tools.downloadMessageFile(
          message.messageId,
          attachment.id,
          attachmentResourceType(attachment)
        );
        const parsed = await parseFeishuDownloadedResource(downloaded, {
          maxCharacters: Math.min(maxAttachmentCharacters, maxCharacters - characters)
        });
        append({
          id: `message:${message.messageId}:${attachment.id}`,
          title: attachment.name ?? parsed.fileName ?? `Feishu ${attachment.kind} attachment`,
          text: parsed.text
        });
      } catch {
        // Images/audio/video remain typed attachment references when text extraction is unavailable.
      }
    }
    return context;
  };
}
