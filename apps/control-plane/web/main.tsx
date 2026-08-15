import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createConsoleApi } from "./api.js";
import { createConsoleRouter } from "./router.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 15_000,
      retry: 1,
      staleTime: 5_000,
    },
  },
});
const api = createConsoleApi();
const router = createConsoleRouter({ api, queryClient });
const rootElement = document.getElementById("root");

if (!rootElement) throw new Error("console_root_missing");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
