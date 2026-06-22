import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SyncEvent } from "../../../../packages/shared/types";

export const MAX_LOG_LINES = 50;
export const MAX_EVENTS = 500;

export type AccountStatus = {
  state: "active" | "ok" | "error";
  source: string;
  log: Array<{ ts: string; message: string; level: string }>;
};

export type SyncStreamState = {
  run_id: string | null;
  running: boolean;
  accounts: Record<string, AccountStatus>;
  events: SyncEvent[];
};

export const initialState: SyncStreamState = {
  run_id: null,
  running: false,
  accounts: {},
  events: [],
};

type Action = { type: "event"; event: SyncEvent };

function appendEvent(events: SyncEvent[], e: SyncEvent): SyncEvent[] {
  const next = events.length >= MAX_EVENTS ? events.slice(1) : events.slice();
  next.push(e);
  return next;
}

export function reducer(state: SyncStreamState, action: Action): SyncStreamState {
  if (action.type !== "event") return state;
  const e = action.event;
  switch (e.type) {
    case "sync_started":
      return {
        ...initialState,
        run_id: e.run_id,
        running: true,
        events: [e],
      };
    case "sync_finished":
      return { ...state, running: false, events: appendEvent(state.events, e) };
    case "account_started":
      return {
        ...state,
        accounts: {
          ...state.accounts,
          [e.account_id]: { state: "active", source: e.source, log: [] },
        },
        events: appendEvent(state.events, e),
      };
    case "account_finished": {
      const prev = state.accounts[e.account_id];
      const events = appendEvent(state.events, e);
      if (!prev) return { ...state, events };
      return {
        ...state,
        accounts: {
          ...state.accounts,
          [e.account_id]: { ...prev, state: e.ok ? "ok" : "error" },
        },
        events,
      };
    }
    case "account_log": {
      const prev = state.accounts[e.account_id];
      const events = appendEvent(state.events, e);
      if (!prev) return { ...state, events };
      const log = [...prev.log, { ts: e.ts, message: e.message, level: e.level }];
      if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
      return {
        ...state,
        accounts: { ...state.accounts, [e.account_id]: { ...prev, log } },
        events,
      };
    }
    case "warning":
      return { ...state, events: appendEvent(state.events, e) };
  }
}

const Ctx = createContext<SyncStreamState>(initialState);

export function SyncStreamProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/sync/stream");
    es.onmessage = (msg) => {
      let event: SyncEvent;
      try {
        event = JSON.parse(msg.data) as SyncEvent;
      } catch {
        // Malformed SSE payload — ignore. Errors from dispatch or
        // invalidateQueries should surface, not be swallowed here.
        return;
      }
      dispatch({ type: "event", event });
      if (event.type === "sync_finished") {
        queryClient.invalidateQueries();
      }
    };
    return () => es.close();
  }, [queryClient]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useAccountSyncStatus(accountId: string): AccountStatus | undefined {
  return useContext(Ctx).accounts[accountId];
}

export function useSyncRunning(): boolean {
  return useContext(Ctx).running;
}

export function useSyncEvents(): SyncEvent[] {
  return useContext(Ctx).events;
}

export function useSyncRunId(): string | null {
  return useContext(Ctx).run_id;
}
