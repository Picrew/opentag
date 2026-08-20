import type { FeishuOpenApiClient } from "./client.js";
import type { FeishuResource } from "./types.js";

type SheetInfo = {
  sheet_id?: string;
  title?: string;
  index?: number;
  row_count?: number;
  column_count?: number;
};

type SheetQueryResponse = { sheets?: SheetInfo[] };
type SheetValuesResponse = { valueRange?: { range?: string; values?: unknown[][] } };

function columnName(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function createFeishuSheetReader(client: FeishuOpenApiClient) {
  return {
    async readSheet(spreadsheetToken: string, options: {
      maxSheets?: number;
      maxCells?: number;
      maxCharacters?: number;
    } = {}): Promise<FeishuResource> {
      if (!spreadsheetToken.trim()) throw new Error("Feishu spreadsheet token must not be empty.");
      const maxSheets = Math.max(options.maxSheets ?? 20, 1);
      const maxCells = Math.max(options.maxCells ?? 20_000, 1);
      const maxCharacters = Math.max(options.maxCharacters ?? 500_000, 1);
      const data = await client.requestJson<SheetQueryResponse>(
        `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`
      );
      const sections: string[] = [];
      let cellsRead = 0;
      let truncated = (data.sheets?.length ?? 0) > maxSheets;

      for (const sheet of (data.sheets ?? []).slice(0, maxSheets)) {
        if (!sheet.sheet_id || cellsRead >= maxCells) {
          truncated = true;
          break;
        }
        const available = maxCells - cellsRead;
        const columns = Math.max(Math.min(sheet.column_count ?? 26, available), 1);
        const rows = Math.max(Math.min(sheet.row_count ?? 200, Math.floor(available / columns)), 1);
        const range = `${sheet.sheet_id}!A1:${columnName(columns)}${rows}`;
        const values = await client.requestJson<SheetValuesResponse>(
          `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`
        );
        const rowsRead = values.valueRange?.values ?? [];
        cellsRead += rowsRead.reduce((count, row) => count + row.length, 0);
        sections.push(`## ${sheet.title ?? sheet.sheet_id}\n${rowsRead.map((row) => row.map(cellText).join("\t")).join("\n")}`);
        if ((sheet.row_count ?? rows) > rows || (sheet.column_count ?? columns) > columns) truncated = true;
      }

      const fullText = sections.join("\n\n");
      if (fullText.length > maxCharacters) truncated = true;
      return {
        id: spreadsheetToken,
        type: "sheet",
        text: fullText.slice(0, maxCharacters),
        metadata: { token: spreadsheetToken, sheetCount: sections.length, cellsRead, truncated }
      };
    }
  };
}

export type FeishuSheetReader = ReturnType<typeof createFeishuSheetReader>;
