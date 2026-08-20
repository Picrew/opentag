import { describe, expect, it, vi } from "vitest";
import {
  createFeishuBitableReader,
  createFeishuSheetReader,
  createFeishuTools,
  type FeishuOpenApiClient
} from "../src/index.js";

function clientWith(handler: (path: string, options: unknown) => unknown): FeishuOpenApiClient {
  return {
    requestJson: vi.fn(async (path: string, options?: unknown) => handler(path, options)) as FeishuOpenApiClient["requestJson"],
    requestBinary: vi.fn(async () => ({
      bytes: new TextEncoder().encode("file body"),
      fileName: "notes.txt",
      mediaType: "text/plain"
    }))
  };
}

describe("Feishu structured resource readers", () => {
  it("reads a bounded spreadsheet range as tab-separated text", async () => {
    const client = clientWith((path) => path.endsWith("/sheets/query")
      ? { sheets: [{ sheet_id: "s1", title: "Tasks", row_count: 2, column_count: 2 }] }
      : { valueRange: { values: [["Name", "State"], ["Docs", "Done"]] } });
    await expect(createFeishuSheetReader(client).readSheet("sheet_1")).resolves.toMatchObject({
      id: "sheet_1",
      type: "sheet",
      text: "## Tasks\nName\tState\nDocs\tDone",
      metadata: { cellsRead: 4, truncated: false }
    });
  });

  it("reads Bitable records with explicit table and record limits", async () => {
    const client = clientWith((path) => path.endsWith("/tables")
      ? { items: [{ table_id: "tbl1", name: "Tasks" }] }
      : { items: [{ record_id: "rec1", fields: { Name: "Docs" } }] });
    const result = await createFeishuBitableReader(client).readBitable("base_1", { maxRecords: 10 });
    expect(result.text).toContain('"Name": "Docs"');
    expect(result.metadata).toMatchObject({ tableCount: 1, recordsRead: 1 });
  });
});

describe("Feishu unified tools", () => {
  it("dispatches Wiki nodes through their underlying document token", async () => {
    const client = clientWith((path) => path.includes("spaces/get_node")
      ? { node: { node_token: "wik1", obj_token: "doc1", obj_type: "docx", title: "Guide" } }
      : { content: "Guide body" });
    await expect(createFeishuTools(client).readResource({ token: "wik1", type: "wiki" })).resolves.toMatchObject({
      id: "doc1",
      title: "Guide",
      text: "Guide body",
      metadata: { wikiNodeToken: "wik1" }
    });
  });

  it("downloads and parses explicit Drive file references", async () => {
    const client = clientWith(() => ({}));
    await expect(createFeishuTools(client).readResource({ token: "file1", type: "file" })).resolves.toMatchObject({
      id: "file1",
      text: "file body",
      metadata: { parser: "text", size: 9 }
    });
    expect(client.requestBinary).toHaveBeenCalledWith("/open-apis/drive/v1/medias/file1/download", {});
  });

  it("downloads an explicitly selected message attachment", async () => {
    const client = clientWith(() => ({}));
    await expect(createFeishuTools(client).readResource({
      id: "om1",
      type: "message",
      title: "notes.txt",
      metadata: { messageId: "om1", fileKey: "file1", resourceType: "file" }
    })).resolves.toMatchObject({ text: "file body", metadata: { parser: "text" } });
    expect(client.requestBinary).toHaveBeenCalledWith(
      "/open-apis/im/v1/messages/om1/resources/file1",
      { query: { type: "file" } }
    );
  });
});
