// Renderer entry point: builds the app object every panel is handed, wires the toolbar, and owns
// the one render loop.
//
// There is no local model. A render reads the subscription's cache, and every mutation is a
// reducer call — which is the user's whole reason for putting this data in SpacetimeDB. The two
// rules that fall out of that are worth stating once:
//
//   * A gesture may move a bar immediately, but the row is the truth. A refused reducer changes
//     nothing on the server, so the next render paints the old values and the bar snaps back.
//   * A refusal is a sentence written for a human. It is shown verbatim.

import { isAuthRefusal, showPassphraseGate } from './auth';
import { HEAD_W, createTaskAt, installChartMetrics, renderChart, zoomAt } from './chart';
import { PlannerConnection, refusalText } from './connection';
import { today } from './dates';
import { initParticles, markFresh } from './fx';
import { renderInspector } from './inspector';
import { renderPeople } from './people';
import { exportPlan, importPlan, wipePlan } from './planio';
import { EMPTY_SNAPSHOT, snapshotOf, type Snapshot } from './store';
import type { CallOptions, PlannerApp, RowKind, Selection } from './types';
import { LANE_PALETTE, byId, clamp, toast } from './ui';

const MIN_DAY_WIDTH = 8;
const MAX_DAY_WIDTH = 200;

async function boot(): Promise<void> {
  installChartMetrics();
  initParticles();

  const config = (await window.planner?.config()) ?? {
    uri: 'ws://127.0.0.1:3000',
    database: 'vertico-planner',
    smoke: false,
    versions: { electron: '?', chrome: '?' },
  };

  const hosts = {
    scroll: byId('chartScroll'),
    inner: byId('chartInner'),
    timeline: byId('timeline'),
    lanes: byId('lanes'),
    empty: byId('chartEmpty'),
    people: byId('people'),
    inspectorTitle: byId('inspectorTitle'),
    inspector: byId('inspector'),
    status: byId('status'),
    banner: byId('offlineBanner'),
    bannerDetail: byId('offlineDetail'),
  };

  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  let selection: Selection = { kind: 'none' };
  let pendingSelect: 'task' | 'lane' | 'person' | null = null;
  let renderQueued = false;
  let firstPaintReported = false;
  const bootedAt = Date.now();

  const connection = new PlannerConnection(config.uri, config.database, {
    onStatus: (status, detail) => {
      hosts.status.dataset.state = status;
      const label = hosts.status.querySelector('.status-text');
      if (label) {
        label.textContent =
          status === 'connected'
            ? config.database
            : status === 'connecting'
              ? 'Connecting…'
              : 'Not connected';
      }
      hosts.status.title =
        status === 'connected' ? `${config.uri} · ${config.database}` : (detail ?? '');
      hosts.banner.hidden = status !== 'offline';
      hosts.bannerDetail.textContent =
        status === 'offline'
          ? `${config.database} at ${config.uri} is unreachable, so nothing you change here is being saved. ${detail ?? ''}`.trim()
          : '';
      app.requestRender();
    },
    onChange: () => app.requestRender(),
    onInsert: (kind: RowKind, id: bigint) => {
      markFresh(kind, id);
      if (pendingSelect && pendingSelect === kind) {
        pendingSelect = null;
        selection = { kind, id } as Selection;
      }
    },
  });

  const app: PlannerApp = {
    get conn() {
      return connection.conn;
    },
    get connected() {
      return connection.status === 'connected';
    },
    get snapshot() {
      return snapshot;
    },
    get selection() {
      return selection;
    },
    dayWidth: 28,
    originDay: today() - 7,
    dayCount: 60,
    dragging: false,

    requestRender() {
      if (renderQueued) return;
      renderQueued = true;
      window.requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    },

    select(next: Selection) {
      selection = next;
      app.requestRender();
    },

    say(message: string, kind: 'info' | 'error' = 'info') {
      toast(message, kind);
    },

    async call(run: () => Promise<void>, options: CallOptions = {}): Promise<boolean> {
      if (!connection.conn) {
        app.say('Not connected — that change was not saved.', 'error');
        app.requestRender();
        return false;
      }
      try {
        await run();
        return true;
      } catch (error) {
        const text = refusalText(error);
        if (isAuthRefusal(text)) {
          showPassphraseGate(app);
        } else if (!options.ignore || !options.ignore.test(text)) {
          app.say(text, 'error');
        }
        // The row never changed, so re-rendering is what puts a dragged bar back where it was.
        app.requestRender();
        return false;
      }
    },

    selectNext(kind) {
      pendingSelect = kind;
    },

    scrollToDay(day: number) {
      const x = (day - app.originDay) * app.dayWidth + HEAD_W;
      hosts.scroll.scrollLeft = Math.max(0, x - hosts.scroll.clientWidth / 2);
    },
  };

  function render(): void {
    // A render mid-gesture would rebuild the element the pointer is captured on. Every gesture
    // asks for a render when it ends, so nothing is lost by skipping this one.
    if (app.dragging) return;

    snapshot = snapshotOf(connection.conn);
    renderChart(app, hosts);
    renderPeople(app, hosts.people);
    renderInspector(app, { title: hosts.inspectorTitle, body: hosts.inspector });

    reportReadyOnce();
  }

  /**
   * Told to the main process once, so `--smoke` can pass or fail on something real. It waits for
   * the subscription so the report carries row counts — but only for a few seconds, because an
   * app that cannot reach its database must still open and say so.
   */
  function reportReadyOnce(): void {
    if (firstPaintReported) return;
    if (connection.status !== 'connected' && Date.now() - bootedAt < 6000) return;
    firstPaintReported = true;
    window.planner?.signalReady({
      status: connection.status,
      database: config.database,
      lanes: snapshot.lanes.length,
      tasks: snapshot.tasks.length,
      people: snapshot.people.length,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------------------------

  byId('btnNewTask').addEventListener('click', () => {
    const lane =
      (selection.kind === 'lane' && snapshot.laneById.get(selection.id)) ||
      (selection.kind === 'task' && snapshot.laneById.get(snapshot.taskById.get(selection.id)!.laneId)) ||
      snapshot.lanes[0];
    if (!lane) {
      app.say('Add a lane first — a task has to live in one.', 'error');
      return;
    }
    createTaskAt(app, lane.id, today());
    app.scrollToDay(today());
  });

  byId('btnNewLane').addEventListener('click', () => {
    const order = snapshot.lanes.length;
    app.selectNext('lane');
    void app.call(() =>
      app.conn!.reducers.createLane({
        name: 'New lane',
        colour: LANE_PALETTE[order % LANE_PALETTE.length],
        sortOrder: order,
      })
    );
  });

  byId('btnNewPerson').addEventListener('click', () => {
    const colour = LANE_PALETTE[snapshot.people.length % LANE_PALETTE.length];
    app.selectNext('person');
    void app.call(() =>
      app.conn!.reducers.createPerson({
        name: 'New person',
        role: '',
        avatarColour: colour,
        initials: '',
      })
    );
  });

  const DEFAULT_DAY_WIDTH = 28;

  byId('btnZoomIn').addEventListener('click', () => {
    app.dayWidth = clamp(Math.round(app.dayWidth * 1.3), MIN_DAY_WIDTH, MAX_DAY_WIDTH);
    app.requestRender();
  });
  byId('btnZoomOut').addEventListener('click', () => {
    app.dayWidth = clamp(Math.round(app.dayWidth / 1.3), MIN_DAY_WIDTH, MAX_DAY_WIDTH);
    app.requestRender();
  });
  byId('btnToday').addEventListener('click', () => app.scrollToDay(today()));

  byId('btnExport').addEventListener('click', () => void exportPlan(app));
  byId('btnImport').addEventListener('click', () => void importPlan(app));
  byId('btnWipe').addEventListener('click', () => void wipePlan(app));
  byId('btnRetry').addEventListener('click', () => connection.retryNow());

  // Ctrl/Cmd+wheel zooms the chart, anchored under the pointer — the same gesture as every other
  // zoomable canvas, and the one a trackpad's pinch-to-zoom already arrives as (browsers report
  // pinch as a wheel event with `ctrlKey` set, whether or not Ctrl is physically held). A plain
  // wheel keeps meaning "scroll": overriding that would fight the pane's own panning.
  hosts.scroll.addEventListener(
    'wheel',
    event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = clamp(Math.round(app.dayWidth * factor), MIN_DAY_WIDTH, MAX_DAY_WIDTH);
      zoomAt(app, hosts.scroll, event.clientX, next);
    },
    { passive: false }
  );

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      app.select({ kind: 'none' });
      return;
    }
    // Not while someone is typing a lane name or a task's day count.
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

    if (event.key === '+' || event.key === '=') {
      app.dayWidth = clamp(Math.round(app.dayWidth * 1.3), MIN_DAY_WIDTH, MAX_DAY_WIDTH);
      app.requestRender();
    } else if (event.key === '-' || event.key === '_') {
      app.dayWidth = clamp(Math.round(app.dayWidth / 1.3), MIN_DAY_WIDTH, MAX_DAY_WIDTH);
      app.requestRender();
    } else if (event.key === '0') {
      app.dayWidth = DEFAULT_DAY_WIDTH;
      app.requestRender();
    }
  });

  // Anything that reaches the window during a gesture ends it, so a pointer released outside the
  // window cannot leave renders switched off.
  window.addEventListener('pointerup', () => {
    if (!app.dragging) return;
    app.dragging = false;
    app.requestRender();
  });

  connection.connect();
  app.requestRender();

  // Scroll to today once the first rows land, rather than sitting at the far past.
  window.setTimeout(() => app.scrollToDay(today()), 400);
  // If the database never answers, this is the render that lets the window report in anyway.
  window.setTimeout(() => app.requestRender(), 6100);
}

void boot().catch(error => {
  // Nothing has painted yet if this fires, so say so where it can be seen.
  document.body.textContent = `Vertico Planner failed to start: ${(error as Error).message}`;
  throw error;
});
