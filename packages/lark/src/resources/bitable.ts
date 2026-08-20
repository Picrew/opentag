import type { FeishuOpenApiClient } from "./client.js";
import type { FeishuResource } from "./types.js";

type BitableTable = { table_id?: string; name?: string };
type BitableTablePage = { items?: BitableTable[]; has_more?: boolean; page_token?: string };
type BitableRecord = { record_id?: string; fields?: Record<string, unknown>; created_by?: unknown; created_time?: number };
type BitableRecordPage = { items?: BitableRecord[]; has_more?: boolean; page_token?: string; total?: number };

export function createFeishuBitableReader(client: FeishuOpenApiClient) {
  return {
    async readBitable(appToken: string, options: {
      maxTables?: number;
      maxRecords?: number;
      maxCharacters?: number;
    } = {}): Promise<FeishuResource> {
      if (!appToken.trim()) throw new Error("Feishu Bitable app token must not be empty.");
      const maxTables = Math.max(options.maxTables ?? 20, 1);
      const maxRecords = Math.max(options.maxRecords ?? 500, 1);
      const maxCharacters = Math.max(options.maxCharacters ?? 500_000, 1);
      const tables: BitableTable[] = [];
      let tablePageToken: string | undefined;
      let truncated = false;

      do {
        const page = await client.requestJson<BitableTablePage>(
          `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
          { query: { page_size: Math.min(maxTables - tables.length, 100), page_token: tablePageToken } }
        );
        tables.push(...(page.items ?? []).slice(0, maxTables - tables.length));
        tablePageToken = page.has_more && tables.length < maxTables ? page.page_token : undefined;
        if (page.has_more && !tablePageToken) truncated = true;
      } while (tablePageToken && tables.length < maxTables);

      const sections: string[] = [];
      let recordsRead = 0;
      for (const table of tables) {
        if (!table.table_id || recordsRead >= maxRecords) {
          truncated = true;
          break;
        }
        const records: BitableRecord[] = [];
        let recordPageToken: string | undefined;
        do {
          const remaining = maxRecords - recordsRead - records.length;
          const page = await client.requestJson<BitableRecordPage>(
            `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(table.table_id)}/records`,
            { query: { page_size: Math.min(remaining, 500), page_token: recordPageToken } }
          );
          records.push(...(page.items ?? []).slice(0, remaining));
          recordPageToken = page.has_more && records.length < remaining ? page.page_token : undefined;
          if (page.has_more && !recordPageToken) truncated = true;
        } while (recordPageToken && recordsRead + records.length < maxRecords);
        recordsRead += records.length;
        sections.push(`## ${table.name ?? table.table_id}\n${JSON.stringify(records.map((record) => ({
          recordId: record.record_id,
          fields: record.fields ?? {}
        })), null, 2)}`);
      }

      const fullText = sections.join("\n\n");
      if (fullText.length > maxCharacters || tables.length >= maxTables || recordsRead >= maxRecords) truncated = true;
      return {
        id: appToken,
        type: "bitable",
        text: fullText.slice(0, maxCharacters),
        metadata: { token: appToken, tableCount: tables.length, recordsRead, truncated }
      };
    }
  };
}

export type FeishuBitableReader = ReturnType<typeof createFeishuBitableReader>;
