import {
  createFeishuOpenApiClient,
  createFeishuResourceContextResolver,
  createFeishuTenantTokenProvider,
  createFeishuTools,
  larkIngressConfigFromEnv,
  startLarkIngress
} from "./ingress.js";

function handleStartupError(error: unknown): never {
  console.error("[lark] failed to start long-connection client:", error);
  process.exit(1);
}

try {
  const config = larkIngressConfigFromEnv(process.env);
  const tokenProvider = createFeishuTenantTokenProvider({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain
  });
  const resourceClient = createFeishuOpenApiClient({
    tokenProvider,
    domain: config.domain
  });
  const ingress = startLarkIngress({
    ...config,
    resolveResourceContext: createFeishuResourceContextResolver({
      tools: createFeishuTools(resourceClient)
    })
  });
  ingress.startPromise.catch(handleStartupError);
  console.log("OpenTag Lark events long-connection ingress started");
} catch (error) {
  handleStartupError(error);
}
