// The connection to `vertico-planner`, and the reconnect loop around it.
//
// "Local save" here means the server is on this machine and nothing leaves it — but it also means
// the app is dead when that server is down. So a lost connection is announced, loudly, rather
// than swallowed: every mutation is a reducer call, and a reducer call with no socket must not
// look like an edit that worked.

import { DbConnection, tables } from '../module_bindings';
import type { RowKind } from './types';

export type Status = 'connecting' | 'connected' | 'offline';

export interface ConnectionHandlers {
  /** Called on every status change. `detail` carries the error text when there is one. */
  onStatus(status: Status, detail?: string): void;
  /** Called when the cache changed, and once when the subscription first applies. */
  onChange(): void;
  /** Called for each inserted row, so a freshly created row can be selected. */
  onInsert(kind: RowKind, id: bigint): void;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

export class PlannerConnection {
  conn: DbConnection | null = null;
  status: Status = 'connecting';

  #uri: string;
  #database: string;
  #handlers: ConnectionHandlers;
  #attempt = 0;
  #retryTimer: number | null = null;
  /** Guards against a stale connection's callbacks writing over a newer one's. */
  #generation = 0;

  constructor(uri: string, database: string, handlers: ConnectionHandlers) {
    this.#uri = uri;
    this.#database = database;
    this.#handlers = handlers;
  }

  get uri(): string {
    return this.#uri;
  }

  get database(): string {
    return this.#database;
  }

  /** Opens the connection, or re-opens it after a drop. */
  connect(): void {
    if (this.#retryTimer !== null) {
      window.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    const generation = ++this.#generation;
    this.#setStatus('connecting');

    DbConnection.builder()
      .withUri(this.#uri)
      .withDatabaseName(this.#database)
      .withToken(loadToken())
      .onConnect((conn, _identity, token) => {
        if (generation !== this.#generation) return;
        saveToken(token);
        this.conn = conn;
        this.#attempt = 0;
        this.#watchTables(conn);
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            if (generation !== this.#generation) return;
            this.#setStatus('connected');
            this.#handlers.onChange();
          })
          .onError(() => {
            if (generation !== this.#generation) return;
            this.#setStatus('offline', 'The subscription was refused by the server.');
          })
          .subscribe([tables.person, tables.lane, tables.task, tables.assignment]);
      })
      .onConnectError((_ctx, error) => {
        if (generation !== this.#generation) return;
        this.conn = null;
        this.#setStatus('offline', describe(error));
        this.#scheduleRetry();
      })
      .onDisconnect((_ctx, error) => {
        if (generation !== this.#generation) return;
        this.conn = null;
        this.#setStatus('offline', error ? describe(error) : 'The server closed the connection.');
        this.#handlers.onChange();
        this.#scheduleRetry();
      })
      .build();
  }

  /** The Retry button. Drops any backoff and tries immediately. */
  retryNow(): void {
    this.#attempt = 0;
    this.connect();
  }

  #setStatus(status: Status, detail?: string): void {
    this.status = status;
    this.#handlers.onStatus(status, detail);
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.#attempt, RETRY_DELAYS_MS.length - 1)];
    this.#attempt += 1;
    this.#retryTimer = window.setTimeout(() => {
      this.#retryTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * One render per change, coalesced by the caller. The insert callbacks also report the new id,
   * which is the only way to learn it: a reducer call resolves with nothing.
   */
  #watchTables(conn: DbConnection): void {
    const changed = () => this.#handlers.onChange();

    conn.db.person.onInsert((_ctx, row) => {
      this.#handlers.onInsert('person', row.id);
      changed();
    });
    conn.db.person.onUpdate(changed);
    conn.db.person.onDelete(changed);

    conn.db.lane.onInsert((_ctx, row) => {
      this.#handlers.onInsert('lane', row.id);
      changed();
    });
    conn.db.lane.onUpdate(changed);
    conn.db.lane.onDelete(changed);

    conn.db.task.onInsert((_ctx, row) => {
      this.#handlers.onInsert('task', row.id);
      changed();
    });
    conn.db.task.onUpdate(changed);
    conn.db.task.onDelete(changed);

    conn.db.assignment.onInsert(changed);
    conn.db.assignment.onDelete(changed);
  }
}

/**
 * A refusal arrives as an `Error` whose message is the sentence the reducer returned. It is shown
 * exactly as written — these are written to be read, not parsed.
 */
export function refusalText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '').trim();
  return text.length > 0 ? text : 'The server refused that, without saying why.';
}

function describe(error: unknown): string {
  const text = refusalText(error);
  return text.replace(/\s+/g, ' ').trim();
}

// The identity token is this machine's, for this app. It is not a secret shared with anyone and
// it lets a restart come back as the same identity rather than accumulating new ones.
const TOKEN_KEY = 'vertico-planner.token';

function loadToken(): string | undefined {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* A missing storage is not a reason to refuse to run. */
  }
}
