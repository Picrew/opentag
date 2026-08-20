import { describe, expect, it, vi } from "vitest";
import { createFeishuResourceContextResolver } from "../src/index.js";

describe("Feishu current-message resource context", () => {
  it("reads explicit document URLs and current message files with a shared bound", async () => {
    const readResource = vi.fn(async () => ({
      id: "doc1",
      type: "document" as const,
      title: "Guide",
      text: "Document body",
      sourceUrl: "https://acme.feishu.cn/docx/doc1",
      metadata: { token: "doc1" }
    }));
    const downloadMessageFile = vi.fn(async () => ({
      bytes: new TextEncoder().encode("Attachment body"),
      fileName: "report.txt",
      mediaType: "text/plain"
    }));
    const resolve = createFeishuResourceContextResolver({
      tools: { readResource, downloadMessageFile },
      maxCharacters: 20
    });
    const result = await resolve({
      messageId: "om1",
      text: "Read https://acme.feishu.cn/docx/doc1",
      attachments: [{ id: "file1", kind: "file", name: "report.txt" }]
    });
    expect(result).toEqual([
      expect.objectContaining({ id: "document:doc1", text: "Document body" }),
      expect.objectContaining({ id: "message:om1:file1", text: "Attachm" })
    ]);
    expect(downloadMessageFile).toHaveBeenCalledWith("om1", "file1", "file");
  });

  it("keeps unsupported images out of text context without failing the message", async () => {
    const resolve = createFeishuResourceContextResolver({
      tools: {
        readResource: vi.fn(),
        downloadMessageFile: vi.fn(async () => ({ bytes: new Uint8Array([1]), fileName: "image.png", mediaType: "image/png" }))
      }
    });
    await expect(resolve({
      messageId: "om1",
      text: "",
      attachments: [{ id: "img1", kind: "image" }]
    })).resolves.toEqual([]);
  });
});
