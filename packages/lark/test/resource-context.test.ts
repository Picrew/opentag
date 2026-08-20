import { describe, expect, it, vi } from "vitest";
import { createFeishuResourceContextResolver } from "../src/index.js";

describe("Feishu current-message resource context", () => {
  it("preloads a bounded recent channel transcript as untrusted background context", async () => {
    const getChatHistory = vi.fn(async () => ({
      items: [
        { id: "om-current", type: "message" as const, text: "@bot answer this", metadata: { creatorId: "ou-current" } },
        { id: "om-2", type: "message" as const, text: "Second message", metadata: { creatorId: "ou-2" } },
        { id: "om-thread", type: "message" as const, text: "Thread-only", metadata: { creatorId: "ou-3", rootId: "om-root" } },
        { id: "om-1", type: "message" as const, text: "First message", metadata: { creatorId: "ou-1" } }
      ],
      hasMore: false
    }));
    const resolve = createFeishuResourceContextResolver({
      tools: { readResource: vi.fn(), downloadMessageFile: vi.fn(), getChatHistory }
    });

    const result = await resolve({
      chatId: "oc-chat",
      chatType: "group",
      messageId: "om-current",
      text: "@bot answer this",
      attachments: []
    });

    expect(getChatHistory).toHaveBeenCalledWith("oc-chat", {
      pageSize: 21,
      sortType: "ByCreateTimeDesc"
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: "conversation:oc-chat:channel",
        text: expect.stringMatching(/Background only:.*\[sender ou-1\] First message\n\[sender ou-2\] Second message/s)
      })
    ]);
    expect(result[0]?.text).not.toContain("Thread-only");
    expect(result[0]?.text).not.toContain("answer this");
  });

  it("limits an existing thread transcript to that root", async () => {
    const resolve = createFeishuResourceContextResolver({
      tools: {
        readResource: vi.fn(),
        downloadMessageFile: vi.fn(),
        getChatHistory: vi.fn(async () => ({
          items: [
            { id: "om-current", type: "message" as const, text: "Follow-up", metadata: { rootId: "om-root" } },
            { id: "om-reply", type: "message" as const, text: "Relevant reply", metadata: { rootId: "om-root", creatorId: "ou-2" } },
            { id: "om-other", type: "message" as const, text: "Other thread", metadata: { rootId: "om-other-root" } },
            { id: "om-root", type: "message" as const, text: "Root request", metadata: { creatorId: "ou-1" } }
          ],
          hasMore: false
        }))
      }
    });

    const result = await resolve({
      chatId: "oc-chat",
      messageId: "om-current",
      rootId: "om-root",
      text: "Follow-up",
      attachments: []
    });

    expect(result[0]).toMatchObject({ id: "conversation:oc-chat:om-root" });
    expect(result[0]?.text).toContain("Root request");
    expect(result[0]?.text).toContain("Relevant reply");
    expect(result[0]?.text).not.toContain("Other thread");
  });

  it("makes missing recent-message access visible to the agent", async () => {
    const resolve = createFeishuResourceContextResolver({
      tools: {
        readResource: vi.fn(),
        downloadMessageFile: vi.fn(),
        getChatHistory: vi.fn(async () => { throw new Error("forbidden"); })
      }
    });

    await expect(resolve({
      chatId: "oc-chat",
      messageId: "om-current",
      text: "总结上面的讨论",
      attachments: []
    })).resolves.toEqual([
      expect.objectContaining({
        id: "conversation:oc-chat:channel:unavailable",
        text: expect.stringContaining("could not be read")
      })
    ]);
  });


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
