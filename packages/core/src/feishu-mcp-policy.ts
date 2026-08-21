export const FEISHU_MCP_READ_ONLY_TOOLS = [
  "docx.v1.document.rawContent",
  "docx.builtin.search",
  "drive.v1.file.list",
  "wiki.v2.space.getNode",
  "wiki.v2.space.list",
  "wiki.v2.spaceNode.list",
  "wiki.v1.node.search",
  "im.v1.message.get",
  "im.v1.message.list",
  "bitable.v1.app.get",
  "bitable.v1.appTable.list",
  "bitable.v1.appTableField.list",
  "bitable.v1.appTableRecord.get",
  "bitable.v1.appTableRecord.list",
  "bitable.v1.appTableRecord.search"
] as const;

export const FEISHU_MCP_READ_ONLY_SERVER_NAME = "feishu-openapi-readonly";

const FEISHU_MCP_READ_ONLY_RESOURCES = new Set(
  FEISHU_MCP_READ_ONLY_TOOLS.map(
    (tool) => `mcp__${FEISHU_MCP_READ_ONLY_SERVER_NAME}__${tool.replaceAll(".", "_")}`
  )
);

/**
 * Claude Code identifies MCP calls by an encoded resource name in ACP
 * permission requests. Keep this check tied to both OpenTag's dedicated
 * read-only server and its explicit tool allowlist; a caller-controlled
 * "readonly" substring must never be enough to downgrade an action.
 */
export function isFeishuReadOnlyMcpResource(resource: string | undefined): boolean {
  return resource !== undefined && FEISHU_MCP_READ_ONLY_RESOURCES.has(resource);
}
