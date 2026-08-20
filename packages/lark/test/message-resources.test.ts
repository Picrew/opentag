import { describe, expect, it, vi } from "vitest";
import {
  createFeishuImReader,
  parseFeishuDownloadedResource,
  type FeishuOpenApiClient
} from "../src/index.js";

function clientWith(handler: (path: string, options: unknown) => unknown): FeishuOpenApiClient {
  return {
    requestJson: vi.fn(async (path: string, options?: unknown) => handler(path, options)) as FeishuOpenApiClient["requestJson"],
    requestBinary: vi.fn(async () => ({ bytes: new Uint8Array([1]), fileName: "report.pdf" }))
  };
}

describe("Feishu IM reader", () => {
  it("lists bounded chat history and maps text and attachment messages", async () => {
    const client = clientWith((path, options) => {
      expect(path).toBe("/open-apis/im/v1/messages");
      expect(options).toMatchObject({
        query: { container_id_type: "chat", container_id: "oc_1", page_size: 50 }
      });
      return {
        items: [
          {
            message_id: "om_text",
            chat_id: "oc_1",
            msg_type: "text",
            sender: { id: "ou_1" },
            body: { content: JSON.stringify({ text: "hello" }) }
          },
          {
            message_id: "om_file",
            chat_id: "oc_1",
            msg_type: "file",
            body: { content: JSON.stringify({ file_key: "file_1", file_name: "report.pdf" }) }
          }
        ],
        has_more: true,
        page_token: "next"
      };
    });
    await expect(createFeishuImReader(client).getChatHistory("oc_1", { pageSize: 500 })).resolves.toMatchObject({
      hasMore: true,
      pageToken: "next",
      items: [
        { id: "om_text", text: "hello", metadata: { chatId: "oc_1", creatorId: "ou_1" } },
        { id: "om_file", title: "report.pdf", metadata: { fileKey: "file_1", resourceType: "file" } }
      ]
    });
  });

  it("extracts post text without exposing raw payloads", async () => {
    const client = clientWith(() => ({ items: [{
      message_id: "om_post",
      msg_type: "post",
      body: { content: JSON.stringify({ zh_cn: { title: "Update", content: [[{ tag: "text", text: "Shipped" }]] } }) }
    }] }));
    await expect(createFeishuImReader(client).getMessage("om_post")).resolves.toMatchObject({
      text: "Update\nShipped"
    });
  });

  it("downloads a message resource using the message-scoped endpoint", async () => {
    const client = clientWith(() => ({}));
    await createFeishuImReader(client).downloadMessageResource("om_1", "img_1", "image", { maxBytes: 10 });
    expect(client.requestBinary).toHaveBeenCalledWith(
      "/open-apis/im/v1/messages/om_1/resources/img_1",
      { query: { type: "image" }, maxBytes: 10 }
    );
  });
});

describe("Feishu attachment parser", () => {
  it("decodes text and records truncation", async () => {
    await expect(parseFeishuDownloadedResource({
      bytes: new TextEncoder().encode("abcdef"),
      fileName: "notes.txt",
      mediaType: "text/plain; charset=utf-8"
    }, { maxCharacters: 4 })).resolves.toEqual({
      text: "abcd",
      fileName: "notes.txt",
      mediaType: "text/plain; charset=utf-8",
      parser: "text",
      truncated: true
    });
  });

  it("parses office files with OCR disabled and bounded decompression", async () => {
    const parseOffice = vi.fn(async () => ({ toText: () => "Document body" }));
    await expect(parseFeishuDownloadedResource({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "report.pdf",
      mediaType: "application/pdf"
    }, { parseOffice })).resolves.toMatchObject({ text: "Document body", parser: "office", truncated: false });
    expect(parseOffice).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({
      fileType: "pdf",
      ocr: false,
      extractAttachments: false,
      includeRawContent: false,
      decompressionLimits: expect.objectContaining({ maxZipEntries: 5_000 })
    }));
  });

  it("rejects oversized and unsupported attachment input", async () => {
    await expect(parseFeishuDownloadedResource({ bytes: new Uint8Array(3), fileName: "a.pdf" }, { maxBytes: 2 }))
      .rejects.toThrow(/parsing limit/u);
    await expect(parseFeishuDownloadedResource({ bytes: new Uint8Array([1]), fileName: "a.exe" }))
      .rejects.toThrow(/Unsupported/u);
  });
});
