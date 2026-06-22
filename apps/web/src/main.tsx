import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { PrivacyProvider } from "./lib/privacy";
import { SyncStreamProvider } from "./lib/syncStream";
import { App } from "./App";
import { Welcome } from "./routes/Welcome";

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
import { Settings } from "./routes/Settings";
import { ProjectionsLayout } from "./routes/projections/_shell/ProjectionsLayout";
import { ProjectionsIndex } from "./routes/projections/_shell/ProjectionsIndex";
import { Heloc } from "./routes/projections/heloc/Heloc";
import { Retirement } from "./routes/projections/retirement/Retirement";
import { Mortgage } from "./routes/projections/mortgage/Mortgage";
import "./index.css";

const router = createBrowserRouter([
  { path: "/welcome", element: <Welcome /> },
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
      { path: "settings", element: <Settings /> },
      {
        path: "projections",
        element: <ProjectionsLayout />,
        children: [
          { index: true, element: <ProjectionsIndex /> },
          { path: "heloc", element: <Heloc /> },
          { path: "retirement", element: <Retirement /> },
          { path: "mortgage", element: <Mortgage /> },
        ],
      },
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
