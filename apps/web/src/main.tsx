import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { PrivacyProvider } from "./lib/privacy";
import { SyncStreamProvider } from "./lib/syncStream";
import { App } from "./App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Personal-finance data doesn't change frequently from outside the
      // session — a 30-second freshness window is enough to dedupe rapid
      // navigation without making the UI feel stale.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
import { Overview } from "./routes/Overview";
import { Transactions } from "./routes/Transactions";
import { Spending } from "./routes/Spending";
import { Bundles } from "./routes/Bundles";
import { Goals } from "./routes/Goals";
import { Debt } from "./routes/Debt";
import { Investments } from "./routes/Investments";
import { Projections } from "./routes/Projections";
import "./index.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Overview /> },
      { path: "transactions", element: <Transactions /> },
      { path: "spending", element: <Spending /> },
      { path: "spending/:category", element: <Spending /> },
      { path: "bundles", element: <Bundles /> },
      { path: "goals", element: <Goals /> },
      { path: "debt", element: <Debt /> },
      { path: "investments", element: <Investments /> },
      { path: "projections", element: <Projections /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SyncStreamProvider>
        <PrivacyProvider>
          <RouterProvider router={router} />
        </PrivacyProvider>
      </SyncStreamProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
