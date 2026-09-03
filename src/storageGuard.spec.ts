import indexeddb, { IDBKeyRange, IDBTransaction } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Browserbase } from './Browserbase';

globalThis.indexedDB = indexeddb;
globalThis.IDBTransaction = IDBTransaction;
globalThis.IDBKeyRange = IDBKeyRange;

describe('Browserbase storage stall guard', () => {
  const defaults = {
    slow: Browserbase.slowTransactionTimeout,
    hard: Browserbase.transactionTimeout,
    onSlow: Browserbase.onSlowStorage,
  };

  // A wall clock the tests can jump forward, standing in for a tab the browser suspended: the
  // timer still fires on the real event loop, but Date.now() reports that a long time passed
  // meanwhile. This is what the guard actually reads, so it needs no fake timers.
  let clockOffset = 0;
  const realNow = Date.now.bind(Date);

  beforeEach(() => {
    clockOffset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  afterEach(() => {
    Browserbase.slowTransactionTimeout = defaults.slow;
    Browserbase.transactionTimeout = defaults.hard;
    Browserbase.onSlowStorage = defaults.onSlow;
    vi.restoreAllMocks();
  });

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const storeNameList = (names: string[]) => {
    const list: any = [...names];
    list.contains = (name: string) => list.includes(name);
    return list;
  };

  // A transaction that accepts handlers and then never fires one — the wedge itself.
  //
  // `abort()` fires what a real browser fires: `onabort` on the transaction, and an `AbortError`
  // `onerror` on every request still pending on it. Those events are the whole mechanism the
  // stamp-suppression rules are written against, so a fake that merely set a flag would let every
  // test asserting about them pass without exercising anything.
  //
  // Fired SYNCHRONOUSLY, where a browser queues them as tasks. That is deliberately stricter: code
  // that survives the synchronous ordering survives the asynchronous one, and the difference is
  // exactly what hid the abort-beats-rejection bug this fake surfaced.
  function stalledTransaction(names = ['foo']) {
    const trans: any = {
      objectStoreNames: storeNameList(names),
      // Every operation hands back a never-settling request that knows its transaction. The
      // backref is the detail that decides which code path a read takes, so it belongs in the
      // shared fake rather than being remembered per test.
      objectStore: (name: string) => ({
        name,
        keyPath: 'key',
        transaction: trans,
        get: () => trans.request(),
        getAll: () => trans.request(),
        count: () => trans.request(),
        put: () => trans.request(),
        add: () => trans.request(),
        delete: () => trans.request(),
        createIndex() {},
        deleteIndex() {},
      }),
      oncomplete: null,
      onerror: null,
      onabort: null,
      aborted: false,
      pending: [] as any[],
      /** Hand out a request that never settles, tracked so abort() can fail it like a browser would. */
      request() {
        const req: any = { onsuccess: null, onerror: null, transaction: trans };
        trans.pending.push(req);
        return req;
      },
      abort() {
        if (trans.aborted) return;
        trans.aborted = true;
        const abortError = Object.assign(new Error('The transaction was aborted.'), { name: 'AbortError' });
        for (const req of trans.pending.splice(0)) {
          req.error = abortError;
          req.onerror?.({ target: req });
        }
        trans.onabort?.({ target: trans });
      },
    };
    return trans;
  }

  // Opens a Browserbase against a hand-driven connection whose transactions the test controls.
  async function openWith(makeTransaction: () => any) {
    const request: any = {
      result: null,
      transaction: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
    };
    vi.spyOn(indexedDB, 'open').mockReturnValue(request);

    const db = new Browserbase<any>('stall' + (Math.random() + '').slice(2), { dontDispatch: true });
    db.version(1, { foo: 'key' });
    const opening = db.open();

    request.result = {
      closed: false,
      objectStoreNames: storeNameList(['foo']),
      transaction: makeTransaction,
      close() {
        this.closed = true;
      },
      onerror: null,
      onabort: null,
      onversionchange: null,
      onclose: null,
    };
    request.onsuccess();
    await opening;
    return db;
  }

  it('leaves a never-settling transaction alone when both timers are disabled', async () => {
    // The shipped default. A library release must not change how anything already behaves.
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 0;
    const reports: any[] = [];
    Browserbase.onSlowStorage = detail => reports.push(detail);

    const trans = stalledTransaction();
    const db = await openWith(() => trans);

    let state = 'pending';
    const scoped = db.start(['foo']);
    void scoped.commit().then(
      () => (state = 'resolved'),
      () => (state = 'rejected')
    );

    await delay(60);
    expect(state).to.equal('pending');
    expect(reports).to.have.length(0);
    expect(trans.aborted).toBe(false);
  });

  it('reports a slow transaction without disturbing it', async () => {
    Browserbase.slowTransactionTimeout = 20;
    Browserbase.transactionTimeout = 0;
    const reports: any[] = [];
    Browserbase.onSlowStorage = detail => reports.push(detail);

    const trans = stalledTransaction(['foo']);
    const db = await openWith(() => trans);

    let state = 'pending';
    const scoped = db.start(['foo']);
    void scoped.commit().then(
      () => (state = 'resolved'),
      () => (state = 'rejected')
    );

    await delay(50);
    expect(reports).to.have.length(1);
    expect(reports[0].storeNames).to.deep.equal(['foo']);
    expect(reports[0].elapsedMs).toBeGreaterThanOrEqual(20);
    expect(reports[0].lateFire).toBe(false);
    expect(reports[0].dbName).to.equal(db.name);
    // Observation only: the operation itself is untouched.
    expect(state).to.equal('pending');
    expect(trans.aborted).toBe(false);
  });

  it('flags a slow report as lateFire when the clock jumped while the tab slept', async () => {
    Browserbase.slowTransactionTimeout = 20;
    Browserbase.transactionTimeout = 0;
    const reports: any[] = [];
    Browserbase.onSlowStorage = detail => reports.push(detail);

    const db = await openWith(() => stalledTransaction());
    const scoped = db.start(['foo']);
    void scoped.commit().catch(() => {});

    clockOffset = 5000; // suspended before the timer got to run
    await delay(50);

    expect(reports).to.have.length(1);
    expect(reports[0].lateFire).toBe(true);
    expect(reports[0].elapsedMs).toBeGreaterThanOrEqual(5000);
  });

  it('rejects, aborts and dispatches when a transaction outlasts the hard timeout', async () => {
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 20;

    const trans = stalledTransaction(['foo']);
    const db = await openWith(() => trans);
    const errors: Error[] = [];
    db.addEventListener('error', (event: any) => errors.push(event.error));

    const scoped = db.start(['foo']);
    const error: any = await scoped.commit().catch(err => err);

    expect(error.name).to.equal('StorageTimeoutError');
    expect(error.message).toContain('[foo]');
    // The database name embeds a uid in real use, so it must stay out of the message or every
    // user gets their own error group in Sentry.
    expect(error.message).not.toContain(db.name);
    expect(error.dbName).to.equal(db.name);
    expect(error.storeNames).to.deep.equal(['foo']);
    expect(error.elapsedMs).toBeGreaterThanOrEqual(20);
    // A stalled transaction left live could still commit after its caller gave up.
    expect(trans.aborted).toBe(true);
    expect(errors.map(e => e.name)).toContain('StorageTimeoutError');
  });

  it('does not fire once the transaction completes', async () => {
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 30;

    const trans = stalledTransaction();
    const db = await openWith(() => trans);

    const scoped = db.start(['foo']);
    const settled = scoped.commit();
    trans.oncomplete({ target: trans });

    await settled;
    await delay(60);
    expect(trans.aborted).toBe(false);
  });

  it('defers while other work on the same connection is still settling', async () => {
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 30;

    const trans = stalledTransaction();
    const db = await openWith(() => trans);

    const scoped = db.start(['foo']);
    let state = 'pending';
    const settled = scoped.commit().then(
      () => (state = 'resolved'),
      () => (state = 'rejected')
    );

    // A sibling transaction keeps completing, so the connection is demonstrably alive and this
    // one is queued behind work rather than wedged (DAB-834: never abort a healthy queued txn).
    for (let i = 0; i < 4; i++) {
      await delay(20);
      db.storageContext.lastSettleAt = Date.now();
    }
    expect(state).to.equal('pending');
    expect(trans.aborted).toBe(false);

    // Once the connection goes quiet, the deadline lands.
    await delay(90);
    await settled;
    expect(state).to.equal('rejected');
  });

  it('re-arms once when the timer itself came back late, then fires', async () => {
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 25;

    const db = await openWith(() => stalledTransaction());
    const scoped = db.start(['foo']);
    let state = 'pending';
    const settled = scoped.commit().then(
      () => (state = 'resolved'),
      err => {
        state = 'rejected';
        return err;
      }
    );

    // The tab slept through the first window, so that window measured nothing.
    clockOffset = 5000;
    await delay(40);
    expect(state).to.equal('pending');

    // The second window is served awake, so this time it is a real verdict.
    await delay(60);
    const error: any = await settled;
    expect(state).to.equal('rejected');
    expect(error.name).to.equal('StorageTimeoutError');
    expect(error.lateFire).toBe(true);
  });

  it('bounds a stalled read that has no transaction promise behind it', async () => {
    // get/getAll/count settle on the request's own events with no transaction promise to chain
    // onto, so they are the shape with nothing at all to fall back on.
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 20;

    const stalledRequest: any = { onsuccess: null, onerror: null, source: { name: 'foo' } };
    const trans = stalledTransaction();
    trans.objectStore = () => ({ getAll: () => stalledRequest });
    stalledRequest.transaction = trans;

    const db = await openWith(() => trans);
    const error: any = await db.stores.foo.getAll().catch((err: Error) => err);

    expect(error.name).to.equal('StorageTimeoutError');
    expect(error.storeNames).to.deep.equal(['foo']);
    expect(trans.aborted).toBe(true);
  });

  it('does not let its own timeout count as the connection settling', async () => {
    // A guard firing is evidence the connection is WEDGED. If the rejection (or the abort it
    // provokes, which arrives as an ordinary onabort) stamped the context, then on a connection
    // with several in-flight operations each timeout would vouch for the rest and they would keep
    // deferring — delaying exactly the verdicts the guard exists to deliver.
    //
    // This transaction has no chained requests, so it only covers the narrow case; the test below
    // is the one that reaches an ordinary write.
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 20;

    const trans = stalledTransaction();
    const db = await openWith(() => trans);
    const scoped = db.start(['foo']);

    const before = db.storageContext.lastSettleAt;
    clockOffset = 1000; // so any stamp would be unmistakable
    await scoped.commit().catch(() => {});
    await delay(20); // let the abort-driven onabort land too

    expect(trans.aborted).toBe(true);
    expect(db.storageContext.lastSettleAt).toBe(before);
  });

  it('does not stamp when the stalled transaction has a request in flight', async () => {
    // The case that matters, and the one the request-less test above cannot reach: an ordinary
    // put/add/delete passes `store.transaction`, so it runs its OWN requestToPromise closure over
    // the same connection. A mark held in the transaction's closure leaves this path stamping —
    // which is every normal write.
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 20;

    // The fake's `transaction` backref is load-bearing here: without it `put()` would take the
    // transaction-less path, arm a guard of its own, and the test would pass vacuously.
    const trans = stalledTransaction();
    const db = await openWith(() => trans);
    const scoped = db.start(['foo']);
    const writing = scoped.stores.foo.put({ key: 'a' }).catch((err: Error) => err);
    const committing = scoped.commit().catch((err: Error) => err);

    const before = db.storageContext.lastSettleAt;
    clockOffset = 1000; // so any stamp would be unmistakable
    const [writeErr, commitErr] = await Promise.all([writing, committing]);
    await delay(20); // let the abort-driven handlers land

    // The transaction owns the deadline and reports the typed stall; the write is collateral,
    // failed by the abort exactly as a browser fails a pending request. A write that had armed a
    // guard of its own — the trap that would make this test vacuous — would carry
    // StorageTimeoutError here instead.
    expect((commitErr as Error).name).to.equal('StorageTimeoutError');
    expect((writeErr as Error).name).to.equal('AbortError');
    expect(db.storageContext.lastSettleAt).toBe(before);
  });

  it('still stamps the connection when a transaction genuinely settles', async () => {
    // The other half of the invariant above: real settles must keep vouching. The timeout has to
    // be live and simply beaten — with it disabled no guard arms at all, `timedOutTargets` is
    // never consulted, and this would pass identically with the whole mechanism removed.
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 1000;

    const trans = stalledTransaction();
    const db = await openWith(() => trans);
    const scoped = db.start(['foo']);

    const before = db.storageContext.lastSettleAt;
    clockOffset = 1000;
    trans.oncomplete({ target: trans });
    await scoped.commit();

    expect(db.storageContext.lastSettleAt).toBeGreaterThan(before);
  });

  it('reports a scoped transaction once, not once per read on it', async () => {
    // A get/getAll/count inside a start() scope is transaction-less by PARAMETER but runs on the
    // scope's already-armed transaction. Arming again would deadline the same stall twice — and
    // at the measurement defaults (soft on, hard off) that shows up as two slow reports for one
    // slow transaction, double-counting the distribution this instrument exists to produce.
    Browserbase.slowTransactionTimeout = 20;
    Browserbase.transactionTimeout = 0;
    const reports: any[] = [];
    Browserbase.onSlowStorage = detail => reports.push(detail);

    const trans = stalledTransaction();
    const db = await openWith(() => trans);
    const scoped = db.start(['foo']);
    void scoped.stores.foo.getAll().catch(() => {});
    void scoped.stores.foo.get('a').catch(() => {});
    void scoped.commit().catch(() => {});

    await delay(60);
    expect(reports).to.have.length(1);
  });

  it('does not stamp when a scoped read is failed by the transaction abort', async () => {
    // The read's own AbortError must not vouch either — it is the same stall, reported through a
    // different closure. This is the shape dw3 uses (templateCache, accountService).
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 20;

    const trans = stalledTransaction();
    const db = await openWith(() => trans);
    const scoped = db.start(['foo']);
    const reading = scoped.stores.foo.getAll().catch((err: Error) => err);
    const committing = scoped.commit().catch((err: Error) => err);

    const before = db.storageContext.lastSettleAt;
    clockOffset = 1000;
    const [readErr] = await Promise.all([reading, committing]);
    await delay(20);

    expect(trans.aborted).toBe(true);
    // The read really was failed by the abort, not by a deadline of its own.
    expect((readErr as Error).name).to.equal('AbortError');
    expect(db.storageContext.lastSettleAt).toBe(before);
  });

  it('does not mistake ordinary scheduling lag for a suspended tab', async () => {
    // A deferred window is only the remainder of a budget and can be a few milliseconds, so a
    // purely proportional bar would let event-loop jitter burn the single re-arm and stamp a
    // wrong `lateFire` on an error measured wide awake.
    Browserbase.slowTransactionTimeout = 0;
    Browserbase.transactionTimeout = 25;

    const db = await openWith(() => stalledTransaction());
    const scoped = db.start(['foo']);

    // Well past `budget * LATE_FIRE_FACTOR`, but nowhere near the absolute floor.
    clockOffset = 120;
    const error: any = await scoped.commit().catch(err => err);

    expect(error.name).to.equal('StorageTimeoutError');
    expect(error.lateFire).toBe(false);
  });

  it('shares one storage context between a connection and its transaction clones', async () => {
    const db = await openWith(() => stalledTransaction());
    const scoped = db.start(['foo']);
    expect(scoped.storageContext).toBe(db.storageContext);
    expect(db.storageContext.dbName).to.equal(db.name);
    void scoped.commit().catch(() => {});
  });
});
