// The contract every panel is handed. Kept in its own file so `chart`, `people` and `inspector`
// can talk about the app without importing each other.

import type { DbConnection } from '../module_bindings';
import type { Snapshot } from './store';

export type RowKind = 'person' | 'lane' | 'task' | 'assignment';

export type Selection =
  | { kind: 'none' }
  | { kind: 'task'; id: bigint }
  | { kind: 'lane'; id: bigint }
  | { kind: 'person'; id: bigint };

export interface CallOptions {
  /**
   * A refusal matching this is swallowed instead of shown. Exactly one gesture needs it:
   * dropping an avatar on a bar that already carries that person is refused by design, and the
   * right response to it is nothing at all, not an error the user has to dismiss.
   */
  ignore?: RegExp;
}

export interface PlannerApp {
  /** Null until the first connection succeeds, and again after it is lost. */
  readonly conn: DbConnection | null;
  readonly connected: boolean;
  /** Rebuilt from the subscription on every render. */
  readonly snapshot: Snapshot;
  readonly selection: Selection;

  /** Pixels per day. The zoom buttons change it; the chart reads it. */
  dayWidth: number;
  /** The epoch day at the chart's left edge. */
  originDay: number;
  /** How many days the chart draws. */
  dayCount: number;

  /**
   * True while a bar or an avatar is under the pointer. Renders are deferred until it clears,
   * because rebuilding the DOM mid-gesture would drop the pointer capture the drag depends on.
   */
  dragging: boolean;

  /** Schedules a render for the next frame. Safe to call as often as you like. */
  requestRender(): void;
  /** Selects a row and re-renders. */
  select(selection: Selection): void;
  /** Shows a message. Refusal text is shown verbatim. */
  say(message: string, kind?: 'info' | 'error'): void;

  /**
   * Calls a reducer. Resolves `true` if it committed, `false` if it was refused — and on a
   * refusal it shows the server's sentence and re-renders, which is what snaps an optimistically
   * dragged bar back onto its row.
   */
  call(run: () => Promise<void>, options?: CallOptions): Promise<boolean>;

  /** Selects the next row of this kind that arrives, so a freshly created row opens for editing. */
  selectNext(kind: 'task' | 'lane' | 'person'): void;

  /** Scrolls the chart so `day` is in view. */
  scrollToDay(day: number): void;
}

/** What the preload bridge exposes. Nothing else crosses from the main process. */
export interface PlannerBridge {
  config(): Promise<{
    uri: string;
    database: string;
    smoke: boolean;
    versions: { electron: string; chrome: string };
  }>;
  exportJson(
    suggestedName: string,
    json: string
  ): Promise<{ saved: boolean; path?: string; error?: string }>;
  importJson(): Promise<{ opened: boolean; path?: string; json?: string; error?: string }>;
  signalReady(info: unknown): void;
}

declare global {
  interface Window {
    planner?: PlannerBridge;
  }
}
