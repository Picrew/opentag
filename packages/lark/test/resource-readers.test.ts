import { describe, expect, it, vi } from "vitest";
import {
  createFeishuDocumentReader,
  createFeishuDriveReader,
  createFeishuWikiReader,
  type FeishuOpenApiClient
} from "../src/index.js";

function clientWith(handler: (path: string, options: unknown) => unknown): FeishuOpenApiClient {
  return {
    requestJson: vi.fn(async (path: string, options?: unknown) => handler(path, options)) as FeishuOpenApiClient["requestJson"],
    requestBinary: vi.fn()
  };
}

describe("Feishu document reader", () => {
  it("reads raw document content from a URL token", async () => {
    const client = clientWith((path) => {
      expect(path).toBe("/open-apis/docx/v1/documents/doccn1/raw_content");
      return { content: "Document body", revision_id: 7 };
    });
    await expect(createFeishuDocumentReader(client).readDocument("https://acme.feishu.cn/docx/doccn1")).resolves.toMatchObject({
      id: "doccn1",
      type: "document",
      text: "Document body",
      metadata: { token: "doccn1", revisionId: 7 }
    });
  });

  it("paginates blocks and fails closed on a missing continuation token", async () => {
    let page = 0;
    const client = clientWith(() => {
      page += 1;
      return page === 1
        ? { items: [{ block_id: "b1" }], has_more: true, page_token: "next" }
        : { items: [{ block_id: "b2" }], has_more: false };
    });
    const result = await createFeishuDocumentReader(client).readDocumentBlocks("doccn1");
    expect(result.blocks.map((block) => block.block_id)).toEqual(["b1", "b2"]);

    const invalid = clientWith(() => ({ items: [], has_more: true }));
    await expect(createFeishuDocumentReader(invalid).readDocumentBlocks("doccn1")).rejects.toThrow(/without a page token/u);
  });
});

describe("Feishu Drive reader", () => {
  it("maps Drive resource types and walks folders with cycle protection", async () => {
    const client = clientWith((_path, options) => {
      const query = (options as { query: Record<string, string> }).query;
      if (query.folder_token === "root") {
        return {
          files: [
            { token: "folder1", type: "folder", name: "Folder" },
            { token: "doc1", type: "docx", name: "Doc" }
          ]
        };
      }
      return { files: [{ token: "root", type: "folder", name: "Cycle" }, { token: "sheet1", type: "sheet" }] };
    });
    const reader = createFeishuDriveReader(client);
    await expect(reader.listDriveFolder("root")).resolves.toMatchObject({
      items: [{ id: "folder1", type: "folder" }, { id: "doc1", type: "document" }]
    });
    const walked = await reader.walkDrive("root");
    expect(walked.map((resource) => resource.id)).toEqual(["folder1", "doc1", "root", "sheet1"]);
    expect(client.requestJson).toHaveBeenCalledTimes(3);
  });

  it("bounds recursive discovery by the configured item limit", async () => {
    const client = clientWith(() => ({
      files: Array.from({ length: 10 }, (_, index) => ({ token: `f${index}`, type: "file" }))
    }));
    await expect(createFeishuDriveReader(client).walkDrive("root", { maxItems: 3 })).resolves.toHaveLength(3);
  });
});

describe("Feishu Wiki reader", () => {
  it("resolves the Wiki node before dispatching its underlying object", async () => {
    const client = clientWith((path) => {
      expect(path).toBe("/open-apis/wiki/v2/spaces/get_node");
      return {
        node: {
          node_token: "wikcn1",
          space_id: "space1",
          obj_token: "doccn1",
          obj_type: "docx",
          title: "Handbook"
        }
      };
    });
    const readResource = vi.fn(async ({ token, type }) => ({ id: token, type, text: "Body", metadata: { token } }));
    const resource = await createFeishuWikiReader(client, { readResource }).readWikiNode("wikcn1");
    expect(readResource).toHaveBeenCalledWith({ token: "doccn1", type: "document" });
    expect(resource).toMatchObject({
      id: "doccn1",
      title: "Handbook",
      metadata: { wikiNodeToken: "wikcn1", wikiSpaceId: "space1", wikiObjectType: "docx" }
    });
  });

  it("lists spaces and nodes as separate discovery APIs", async () => {
    const client = clientWith((path) => path.endsWith("/spaces")
      ? { items: [{ space_id: "space1", name: "Knowledge" }] }
      : { items: [{ node_token: "node1", obj_token: "doc1", obj_type: "docx" }] });
    const reader = createFeishuWikiReader(client, { readResource: vi.fn() });
    await expect(reader.listWikiSpaces()).resolves.toMatchObject({ items: [{ spaceId: "space1" }] });
    await expect(reader.listWikiNodes("space1")).resolves.toMatchObject({ items: [{ nodeToken: "node1", objToken: "doc1" }] });
  });
});
