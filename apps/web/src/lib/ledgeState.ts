export type LedgeAction = "wave" | "reply" | null;
export type LedgePose = "idle" | "working" | "wave" | "reply";

export interface LedgeState {
  workspace: string | null;
  replies: number | null;
  working: boolean;
  action: LedgeAction;
  greeted: boolean;
}

export const INITIAL_LEDGE: LedgeState = {
  workspace: null,
  replies: null,
  working: false,
  action: null,
  greeted: false,
};

export type LedgeEvent =
  | {
      type: "observe";
      workspace: string;
      replies: number | null;
      working: boolean;
      animate: boolean;
    }
  | { type: "wave" }
  | { type: "settle" };

/** Observe count changes, never infer an unread message or overall install health. */
export function ledgeReducer(state: LedgeState, event: LedgeEvent): LedgeState {
  if (event.type === "settle") return { ...state, action: null };
  if (event.type === "wave") {
    return state.action === "reply" ? state : { ...state, action: "wave" };
  }
  const sameWorkspace = state.workspace === event.workspace;
  const increased =
    sameWorkspace &&
    state.replies !== null &&
    event.replies !== null &&
    event.replies > state.replies;
  return {
    greeted: state.greeted || event.replies !== null,
    workspace: event.workspace,
    replies: event.replies,
    working: event.replies !== null && event.working,
    action:
      event.replies === null || !event.animate
        ? null
        : !state.greeted
          ? "wave"
          : increased
            ? "reply"
            : sameWorkspace || state.workspace === null
              ? state.action
              : null,
  };
}

export function ledgePose(state: LedgeState, animate: boolean): LedgePose {
  return (animate && state.action) || (state.working ? "working" : "idle");
}
