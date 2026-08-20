import type { FeishuOpenApiClient } from "./client.js";
import type { FeishuPage, FeishuResource, FeishuResourceType } from "./types.js";

export type FeishuWikiSpace = {
  spaceId: string;
  name?: string;
  description?: string;
  visibility?: string;
};

export type FeishuWikiNode = {
  nodeToken: string;
  spaceId?: string;
  parentNodeToken?: string;
  objToken: string;
  objType: string;
  title?: string;
  hasChild?: boolean;
};

type WikiSpacePageResponse = {
  items?: Array<Record<string, unknown>>;
  has_more?: boolean;
  page_token?: string;
};

type WikiNodePageResponse = {
  items?: Array<Record<string, unknown>>;
  has_more?: boolean;
  page_token?: string;
};

type WikiNodeResponse = {
  node?: Record<string, unknown>;
};

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
}

function wikiSpace(value: Record<string, unknown>): FeishuWikiSpace | undefined {
  const spaceId = stringField(value, "space_id", "spaceId");
  if (!spaceId) return undefined;
  const name = stringField(value, "name");
  const description = stringField(value, "description");
  const visibility = stringField(value, "visibility");
  return {
    spaceId,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(visibility ? { visibility } : {})
  };
}

function wikiNode(value: Record<string, unknown>): FeishuWikiNode | undefined {
  const nodeToken = stringField(value, "node_token", "nodeToken");
  const objToken = stringField(value, "obj_token", "objToken");
  const objType = stringField(value, "obj_type", "objType");
  if (!nodeToken || !objToken || !objType) return undefined;
  const spaceId = stringField(value, "space_id", "spaceId");
  const parentNodeToken = stringField(value, "parent_node_token", "parentNodeToken");
  const title = stringField(value, "title");
  return {
    nodeToken,
    objToken,
    objType,
    ...(spaceId ? { spaceId } : {}),
    ...(parentNodeToken ? { parentNodeToken } : {}),
    ...(title ? { title } : {}),
    ...(typeof value.has_child === "boolean" ? { hasChild: value.has_child } : {})
  };
}

function resourceType(objType: string): FeishuResourceType {
  if (objType === "doc" || objType === "docx") return "document";
  if (objType === "sheet") return "sheet";
  if (objType === "bitable") return "bitable";
  if (objType === "folder") return "folder";
  return "file";
}

export function createFeishuWikiReader(
  client: FeishuOpenApiClient,
  options: { readResource(reference: { token: string; type: FeishuResourceType; sourceUrl?: string }): Promise<FeishuResource> }
) {
  async function listWikiSpaces(input: { pageSize?: number; pageToken?: string } = {}): Promise<FeishuPage<FeishuWikiSpace>> {
    const data = await client.requestJson<WikiSpacePageResponse>("/open-apis/wiki/v2/spaces", {
      query: {
        page_size: Math.min(Math.max(input.pageSize ?? 50, 1), 50),
        page_token: input.pageToken
      }
    });
    return {
      items: (data.items ?? []).map(wikiSpace).filter((item): item is FeishuWikiSpace => item !== undefined),
      hasMore: data.has_more === true,
      ...(data.page_token ? { pageToken: data.page_token } : {})
    };
  }

  async function listWikiNodes(
    spaceId: string,
    input: { parentNodeToken?: string; pageSize?: number; pageToken?: string } = {}
  ): Promise<FeishuPage<FeishuWikiNode>> {
    if (!spaceId.trim()) throw new Error("Feishu Wiki space id must not be empty.");
    const data = await client.requestJson<WikiNodePageResponse>(
      `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      {
        query: {
          parent_node_token: input.parentNodeToken,
          page_size: Math.min(Math.max(input.pageSize ?? 50, 1), 50),
          page_token: input.pageToken
        }
      }
    );
    return {
      items: (data.items ?? []).map(wikiNode).filter((item): item is FeishuWikiNode => item !== undefined),
      hasMore: data.has_more === true,
      ...(data.page_token ? { pageToken: data.page_token } : {})
    };
  }

  async function getWikiNode(nodeToken: string): Promise<FeishuWikiNode> {
    if (!nodeToken.trim()) throw new Error("Feishu Wiki node token must not be empty.");
    const data = await client.requestJson<WikiNodeResponse>("/open-apis/wiki/v2/spaces/get_node", {
      query: { token: nodeToken }
    });
    const node = data.node ? wikiNode(data.node) : undefined;
    if (!node) throw new Error("Feishu Wiki response did not include a readable obj_token and obj_type.");
    return node;
  }

  async function readWikiNode(nodeToken: string): Promise<FeishuResource> {
    const node = await getWikiNode(nodeToken);
    const resource = await options.readResource({ token: node.objToken, type: resourceType(node.objType) });
    return {
      ...resource,
      ...(node.title && !resource.title ? { title: node.title } : {}),
      metadata: {
        ...resource.metadata,
        wikiNodeToken: node.nodeToken,
        wikiSpaceId: node.spaceId,
        wikiObjectType: node.objType
      }
    };
  }

  return { listWikiSpaces, listWikiNodes, getWikiNode, readWikiNode };
}

export type FeishuWikiReader = ReturnType<typeof createFeishuWikiReader>;
