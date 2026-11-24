const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const trip = { items: [], tasks: [], expenses: [] };
const session = { user: { id: 'synthetic-user' } };
const row = { data: { data: trip, version: 1 }, error: null };

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function setup(initialSession, { read = () => row, rpc, backup, failBackup = false } = {}) {
    const elements = new Map();
    const storage = new Map();
    const alerts = [];
    const reads = [];
    const writes = [];
    const pendingKey = 'japan_trip_v1_1_pending';
    if (backup) storage.set(pendingKey, backup);
    let onReady;
    let onAuth;
    let currentSession = initialSession;
    let inCallback = false;
    let callbackCalls = 0;
    const timers = [];
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set(['tripContent', 'modal', 'taskEditModal', 'expenseModal'].includes(id) ? ['hidden'] : []);
            elements.set(id, {
                classList: {
                    add: name => classes.add(name),
                    remove: name => classes.delete(name),
                    contains: name => classes.has(name)
                },
                matches: () => false,
                addEventListener(name, handler) { this[name] = handler; },
                value: '',
                reset() {}
            });
        }
        return elements.get(id);
    };
    const emit = (event, nextSession) => {
        currentSession = nextSession;
        inCallback = true;
        try {
            assert.equal(onAuth(event, nextSession), undefined);
        } finally {
            inCallback = false;
        }
    };
    const client = {
        auth: {
            async getSession() {
                if (inCallback) callbackCalls++;
                return { data: { session: currentSession }, error: null };
            },
            onAuthStateChange(callback) { onAuth = callback; },
            async signInWithPassword() {
                emit('SIGNED_IN', session);
                return { data: { session }, error: null };
            }
        },
        from() {
            if (inCallback) callbackCalls++;
            return {
                select: () => ({
                    eq: () => ({
                        abortSignal(signal) {
                            this.signal = signal;
                            return this;
                        },
                        async maybeSingle() {
                            reads.push(currentSession);
                            return structuredClone(await read(this.signal));
                        }
                    })
                })
            };
        },
        rpc(name, args) {
            return {
                abortSignal(signal) {
                    if (inCallback) callbackCalls++;
                    writes.push({ session: currentSession, name, args, signal });
                    return rpc?.(signal) ?? { data: [{ update_success: true, new_version: 2 }] };
                }
            };
        }
    };
    const context = vm.createContext({
        window: { supabase: { createClient: () => client } },
        document: {
            addEventListener(name, callback) { onReady = callback; },
            getElementById: element,
            querySelectorAll: selectors => selectors.includes('#addItem') ? [element('addItem')] : [],
            querySelector: () => null
        },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem(key, value) {
                if (failBackup && key === pendingKey) throw new Error('synthetic storage failure');
                storage.set(key, value);
            },
            removeItem: key => storage.delete(key)
        },
        console: { log() {}, warn() {}, error() {} },
        alert: message => alerts.push(message),
        crypto: { randomUUID: () => 'synthetic-id' },
        AbortController,
        structuredClone,
        setTimeout: callback => timers.push(callback),
        requestAnimationFrame: callback => timers.push(callback)
    });
    const settle = async () => {
        do {
            timers.splice(0).forEach(callback => callback());
            await new Promise(resolve => setImmediate(resolve));
        } while (timers.length);
    };
    for (const file of ['supabase.js', 'app.js']) {
        vm.runInContext(readFileSync(join(__dirname, '..', 'js', file), 'utf8'), context, { filename: file });
    }
    await onReady();
    emit('INITIAL_SESSION', initialSession);
    await settle();
    return {
        element, alerts, reads, writes, emit, settle,
        hidden: () => element('tripContent').classList.contains('hidden'),
        callbackCalls: () => callbackCalls,
        save: () => vm.runInContext('queueCloudSave()', context),
        backup: () => storage.get(pendingKey),
        snapshot: () => storage.get('japan_trip_v1_1')
    };
}

test('signed-out startup stays quiet, hides the trip, and locks editing without a trip read', async () => {
    const app = await setup(null);
    assert.deepEqual(app.reads, []);
    assert.equal(app.hidden(), true);
    assert.equal(app.element('addItem').disabled, true);
    assert.deepEqual(app.alerts, []);
});

test('successful login loads the trip once without a reload or SDK calls inside auth callbacks', async () => {
    const app = await setup(null);
    await app.element('loginForm').submit({ preventDefault() {} });
    await app.settle();
    assert.equal(app.element('loginButton').textContent, '🔓 登出');
    assert.equal(app.reads.length, 1);
    assert.equal(app.hidden(), false);
    assert.equal(app.element('addItem').disabled, false);
    app.emit('SIGNED_IN', session);
    app.emit('TOKEN_REFRESHED', { ...session });
    await app.settle();
    assert.equal(app.reads.length, 1);
    assert.equal(app.callbackCalls(), 0);
});

test('restored session loads the trip and signed-in read errors stay visible', async () => {
    const app = await setup(session);
    assert.equal(app.reads.length, 1);
    assert.equal(app.hidden(), false);
    for (const result of [{ error: { message: 'synthetic error' } }, { data: { ...row.data, version: 0 } }]) {
        const failed = await setup(session, { read: () => result });
        assert.equal(failed.hidden(), true);
        assert.equal(failed.element('addItem').disabled, true);
        assert.equal(failed.alerts.length, 1);
    }
});

test('sign-out ignores a pending trip read even when the same user signs in again', async () => {
    const oldRead = deferred();
    const newRead = deferred();
    let readCount = 0;
    const app = await setup(session, { read: () => (++readCount === 1 ? oldRead : newRead).promise });
    app.emit('SIGNED_OUT', null);
    app.emit('SIGNED_IN', session);
    await app.settle();
    oldRead.resolve(row);
    await app.settle();
    assert.equal(app.reads.length, 2);
    assert.equal(app.hidden(), true);
    assert.equal(app.element('addItem').disabled, true);
    newRead.resolve(row);
    await app.settle();
    assert.equal(app.hidden(), false);
});

test('account change cancels queued writes and keeps the pending backup after an in-flight RPC', async () => {
    const pendingWrite = deferred();
    const app = await setup(session, { rpc: () => pendingWrite.promise });
    const first = app.save();
    const second = app.save();
    const finished = Promise.allSettled([first, second]);
    await app.settle();
    assert.equal(app.writes.length, 1);
    const backup = app.backup();
    app.element('modal').classList.remove('hidden');
    app.emit('SIGNED_OUT', null);
    assert.equal(app.hidden(), true);
    assert.equal(app.writes[0].signal.aborted, true);
    assert.equal(app.element('modal').classList.contains('hidden'), true);
    app.emit('SIGNED_IN', { user: { id: 'other-synthetic-user' } });
    await app.settle();
    assert.equal(app.reads.length, 1);
    pendingWrite.resolve({ data: [{ update_success: true, new_version: 2 }] });
    for (const result of await finished) {
        assert.equal(result.status, 'rejected');
        assert.match(result.reason.message, /登入狀態已變更/);
    }
    await app.settle();
    assert.equal(app.writes.length, 1);
    assert.equal(app.backup(), backup);
    assert.equal(app.reads.length, 2);
    assert.equal(app.element('addItem').disabled, true);
});

test('version conflict still retries with the latest version and clears a confirmed backup', async () => {
    let readCount = 0;
    let writeCount = 0;
    const app = await setup(session, {
        read: () => ({ data: { data: trip, version: ++readCount } }),
        rpc: () => ({ data: [++writeCount === 1
            ? { update_success: false }
            : { update_success: true, new_version: 3 }] })
    });
    const saved = app.save();
    await app.settle();
    await saved;
    assert.deepEqual(app.writes.map(write => write.name), ['update_trip_safely', 'update_trip_safely']);
    assert.deepEqual(app.writes.map(write => write.args.p_expected_version), [1, 2]);
    assert.equal(app.backup(), undefined);
    assert.equal(app.element('addItem').disabled, false);
});

test('existing backup and runtime backup failures keep editing locked across auth transitions', async () => {
    const existing = await setup(null, { backup: 'malformed synthetic backup' });
    assert.deepEqual(existing.alerts, []);
    existing.emit('SIGNED_IN', session);
    await existing.settle();
    assert.equal(existing.hidden(), false);
    assert.equal(existing.element('addItem').disabled, true);
    assert.equal(existing.backup(), 'malformed synthetic backup');
    assert.equal(existing.alerts.length, 1);

    const cloudTask = { id: 'cloud-task', text: 'Cloud synthetic task', owner: 'CCX', type: 'prep' };
    const failed = await setup(session, {
        failBackup: true,
        read: () => ({ data: { ...row.data, data: { ...trip, tasks: [cloudTask] } } })
    });
    failed.element('newTask').value = 'Unsynced synthetic task';
    failed.element('addTask').onclick();
    await failed.settle();
    const snapshot = failed.snapshot();
    assert.equal(JSON.parse(snapshot).tasks[1].text, 'Unsynced synthetic task');
    failed.emit('SIGNED_OUT', null);
    failed.emit('SIGNED_IN', session);
    await failed.settle();
    assert.equal(failed.element('addItem').disabled, true);
    assert.equal(failed.writes.length, 0);
    assert.equal(failed.hidden(), false);
    assert.match(failed.element('checklist').innerHTML, /Cloud synthetic task/);
    assert.doesNotMatch(failed.element('checklist').innerHTML, /Unsynced synthetic task/);
    failed.element('nextDay').onclick();
    assert.match(failed.element('dayTitle').textContent, /12\/29/);
    assert.equal(failed.snapshot(), snapshot);
    failed.element('prevDay').onclick();
    assert.match(failed.element('dayTitle').textContent, /12\/28/);
    assert.equal(failed.snapshot(), snapshot);
});

test('session abort ends a conflict read so the next login can load without a stale RPC', async () => {
    let readCount = 0;
    let conflictAborted = false;
    const app = await setup(session, {
        read: signal => {
            if (++readCount !== 2) return row;
            return new Promise(resolve => {
                signal?.addEventListener('abort', () => {
                    conflictAborted = true;
                    resolve({ error: { message: 'synthetic read aborted' } });
                }, { once: true });
            });
        },
        rpc: () => ({ data: [{ update_success: false }] })
    });
    const rejected = assert.rejects(app.save(), /登入狀態已變更/);
    await app.settle();
    assert.equal(app.reads.length, 2);

    app.emit('SIGNED_OUT', null);
    app.emit('SIGNED_IN', session);
    await app.settle();

    assert.equal(conflictAborted, true);
    await rejected;
    assert.equal(app.reads.length, 3);
    assert.equal(app.hidden(), false);
    assert.equal(app.writes.length, 1);
});

test('add-task handler stays quiet for a detached RPC but reports an active RPC failure', async () => {
    const failure = { error: { message: 'synthetic RPC failure' } };
    const detached = await setup(session, {
        rpc: signal => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('synthetic RPC aborted')), { once: true });
        })
    });
    detached.element('newTask').value = 'Detached synthetic task';
    detached.element('addTask').onclick();
    await detached.settle();
    assert.equal(detached.writes.length, 1);
    const backup = detached.backup();
    assert.ok(backup);
    detached.emit('SIGNED_OUT', null);
    await detached.settle();
    assert.equal(detached.writes.length, 1);
    assert.equal(detached.backup(), backup);
    assert.deepEqual(detached.alerts, []);

    const active = await setup(session, { rpc: () => failure });
    active.element('newTask').value = 'Active synthetic task';
    active.element('addTask').onclick();
    await active.settle();
    assert.equal(active.alerts.length, 1);
    assert.match(active.alerts[0], /新增待辦尚未成功同步/);
    assert.ok(active.backup());
    assert.equal(active.element('addItem').disabled, true);
    await assert.rejects(active.save(), /雲端同步目前不可用/);
    assert.equal(active.writes.length, 1);
});
