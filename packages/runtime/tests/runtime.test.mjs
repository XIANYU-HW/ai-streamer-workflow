import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.mjs';
import { createSimulatedAdapters } from '../simulated-adapters.mjs';

async function fixture(t, config = {}, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'streamer-test-'));
  let time = 1000000;
  const now = () => time;
  const { adapters, calls } = createSimulatedAdapters({ now });
  mutate(adapters);
  const runtime = createRuntime({ directory, config, adapters, now });
  t.after(async () => {
    if (!runtime.closed) { await runtime.stop(); runtime.close(); }
    rmSync(directory, { recursive: true, force: true });
  });
  await runtime.start({ mode: 'demo' });
  return { runtime, directory, adapters, calls, advance: ms => { time += ms; }, now };
}
const decision = playerId => ({ playerId, provider: 'simulated', model: 'synthetic-fixture',
  decisionId: `decision-${playerId}`, evidenceId: `model-${playerId}`, simulated: true });
function speech(kind, id, extra = {}) {
  return { kind, eventId: id, text: `${kind} ${id}`, characterId: 'host-1', review: { accepted: true, evidenceId: 'review' },
    ...(kind === 'idle' ? {} : { origin: { adapterId: 'simulated-chat', platformId: 'synthetic', platformEventId: id, simulated: true, evidenceId: `origin-${id}` } }), ...extra };
}

test('one owner and one lease; expired leases cannot be stolen before confirmed release', async t => {
  const { runtime: r, directory, advance } = await fixture(t);
  assert.throws(() => createRuntime({ directory }), { code: 'DIRECTORY_ALREADY_OWNED' });
  const lease = r.claimControl({ owner: 'player', ttlMs: 10 });
  assert.throws(() => r.claimControl({ owner: 'director' }), { code: 'CONTROL_ALREADY_OWNED_OR_UNCERTAIN' });
  advance(11);
  assert.throws(() => r.assertControl(lease.token), { code: 'CONTROL_LEASE_INVALID' });
  assert.throws(() => r.claimControl({ owner: 'director' }), { code: 'CONTROL_ALREADY_OWNED_OR_UNCERTAIN' });
  await r.releaseControl(lease.token);
  assert.equal(r.claimControl({ owner: 'director' }).generation, 2);
  const saved = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  assert.equal(saved.lease.owner, 'director');
});

test('canonical gift deduplication and gift priority; unknown speech never auto-replays', async t => {
  const { runtime: r, adapters, calls } = await fixture(t);
  r.enqueueSpeech(speech('idle', 'idle'));
  r.enqueueSpeech(speech('chat', 'chat'));
  const gift = speech('gift', 'gift');
  const first = r.enqueueSpeech(gift);
  assert.equal(r.enqueueSpeech({ ...gift, eventId: 'different-local-id' }).id, first.id);
  assert.throws(() => r.enqueueSpeech({ ...gift, text: 'changed text' }), { code: 'EVENT_ID_COLLISION' });
  assert.equal((await r.speakNext()).kind, 'gift');
  assert.equal((await r.speakNext()).kind, 'chat');
  adapters.voice.speak = async () => { throw new Error('Unknown remote delivery'); };
  await assert.rejects(r.speakNext(), /Unknown remote delivery/);
  assert.equal(r.getState().speech.find(j => j.kind === 'idle').status, 'unknown');
  await assert.rejects(r.speakNext(), { code: 'VOICE_RECOVERY_REQUIRED' });
  await r.recoverComponent('voice');
  assert.equal(await r.speakNext(), null);
  assert.equal(r.enqueueSpeech(speech('idle', 'idle')).status, 'unknown');
  assert.equal(calls.filter(c => c.operation === 'speak').length, 2);
});

test('voice fault is isolated; actual start and rotation survive local repair', async t => {
  const { runtime: r, adapters, advance, calls } = await fixture(t, { rotationSeconds: 2 });
  const startedAt = r.getState().actualStartedAt;
  const lease = r.claimControl({ owner: 'game-executor' });
  const speak = adapters.voice.speak;
  adapters.voice.speak = () => { throw new Error('Voice unavailable'); };
  r.enqueueSpeech(speech('idle', '1'));
  await assert.rejects(r.speakNext());
  await r.executeGame({ leaseToken: lease.token, playerId: 'host-1', decision: decision('host-1'), action: { move: 1 } });
  assert.equal(r.getState().lifecycle, 'running');
  assert.equal(r.getState().health.broadcast.status, 'healthy');
  advance(2001);
  await assert.rejects(r.executeGame({ leaseToken: lease.token, playerId: 'host-1', decision: decision('host-1'), action: {} }), { code: 'PLAYER_ROTATION_REQUIRED' });
  assert.equal(await r.rotatePlayer(lease.token), 'host-2');
  await r.executeGame({ leaseToken: lease.token, playerId: 'host-2', decision: decision('host-2'), action: { move: 2 } });
  adapters.voice.speak = speak;
  await r.recoverComponent('voice');
  assert.equal(r.getState().actualStartedAt, startedAt);
  assert.equal(r.clock().elapsedSeconds, 2.001);
  assert.equal(r.getState().health.voice.firstFailure.message, 'Voice unavailable');
  assert.equal(calls.filter(c => c.component === 'broadcast' && c.operation === 'stop').length, 0);
});

test('STOP cancels queued speech, aborts in-flight work, preserves first cause, prevents new work', async t => {
  const { runtime: r, adapters } = await fixture(t);
  await r.reportFault('voice', 'original fault');
  await r.recoverComponent('voice');
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  adapters.voice.speak = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    entered();
  });
  r.enqueueSpeech(speech('idle', '1'));
  r.enqueueSpeech(speech('idle', '2'));
  const speaking = assert.rejects(r.speakNext());
  await started;
  const results = await r.stop('operator_stop');
  await speaking;
  assert.ok(Object.values(results).every(r => r.confirmed));
  assert.deepEqual(r.getState().speech.map(j => j.status), ['unknown', 'cancelled']);
  assert.equal(r.getState().health.voice.firstFailure.message, 'original fault');
  assert.throws(() => r.enqueueSpeech(speech('idle', '3')), { code: 'RUN_NOT_ACTIVE' });
  await assert.rejects(r.start(), { code: 'NEW_SESSION_REQUIRED' });
});

test('missing and simulated adapters cannot claim real output', async t => {
  for (const options of [{ adapters: {}, mode: 'demo', code: 'ADAPTER_UNCONFIGURED' },
    { adapters: createSimulatedAdapters().adapters, mode: 'recording', code: 'ADAPTER_MODE_MISMATCH' }]) {
    const directory = mkdtempSync(join(tmpdir(), 'streamer-empty-'));
    const r = createRuntime({ directory, adapters: options.adapters });
    await assert.rejects(r.start({ mode: options.mode }), { code: options.code });
    assert.equal(r.getState().actualStartedAt, null);
    await r.stop(); r.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('paid calls require opt-in and finite cap; unknown cost retains reservation', async t => {
  const makePaid = adapters => {
    adapters.voice.paid = true;
    adapters.voice.maxCostUSD = { speak: 0.6, stop: 0 };
  };
  const { runtime: disabled } = await fixture(t, {}, makePaid);
  disabled.enqueueSpeech(speech('idle', 'disabled'));
  await assert.rejects(disabled.speakNext(), { code: 'PAID_CALLS_DISABLED' });
  assert.equal(disabled.getState().budget.spentUSD, 0);
  const { runtime: enabled, calls } = await fixture(t, { paidEnabled: true, spendingCapUSD: 1 }, makePaid);
  enabled.enqueueSpeech(speech('idle', '1'));
  enabled.enqueueSpeech(speech('idle', '2'));
  await enabled.speakNext();
  await assert.rejects(enabled.speakNext(), { code: 'SPENDING_CAP_REACHED' });
  assert.equal(Object.keys(enabled.getState().budget.reservations).length, 1);
  assert.equal(calls.filter(c => c.operation === 'speak').length, 1);
});

test('unconfirmed release blocks lease transfer, while a major fault requests hold without stopping output', async t => {
  const { runtime: r, adapters, calls } = await fixture(t);
  const lease = r.claimControl({ owner: 'game-executor' });
  adapters.game.release = () => ({ evidenceId: 'release-unknown', simulated: true, released: false });
  await assert.rejects(r.releaseControl(lease.token), { code: 'INPUT_RELEASE_UNCONFIRMED' });
  assert.equal(r.getState().inputUncertain, true);
  assert.throws(() => r.claimControl({ owner: 'other' }));
  await r.reportFault('game', 'Game recovery needed', { major: true });
  assert.equal(r.getState().lifecycle, 'running');
  assert.ok(calls.some(c => c.operation === 'setScene'));
  assert.ok(!calls.some(c => c.component === 'broadcast' && c.operation === 'stop'));
  assert.equal((await r.stop()).game.confirmed, false);
});

test('stopped session reload keeps original clock and remains terminal', async t => {
  const { runtime: r, directory, adapters } = await fixture(t);
  const startedAt = r.getState().actualStartedAt;
  await r.stop(); r.close();
  const restored = createRuntime({ directory, adapters });
  assert.equal(restored.getState().actualStartedAt, startedAt);
  await assert.rejects(restored.start(), { code: 'NEW_SESSION_REQUIRED' });
  restored.close();
});

test('simultaneous speech dispatch is rejected, and a major voice fault aborts only voice', async t => {
  const { runtime: r, adapters, calls } = await fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  adapters.voice.speak = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('voice interrupted')), { once: true });
    entered();
  });
  r.enqueueSpeech(speech('idle', 'ongoing'));
  const pending = assert.rejects(r.speakNext());
  await started;
  await assert.rejects(r.speakNext(), { code: 'VOICE_BUSY' });
  await r.reportFault('voice', 'major voice issue', { major: true });
  await pending;
  assert.equal(r.getState().speech[0].status, 'unknown');
  assert.equal(r.getState().lifecycle, 'running');
  assert.ok(calls.some(c => c.component === 'voice' && c.operation === 'stop'));
  assert.ok(!calls.some(c => c.component === 'broadcast' && c.operation === 'stop'));
});

test('operation timeout records unknown delivery and does not replay it', async t => {
  const { runtime: r, adapters } = await fixture(t, { operationTimeoutMs: 20 });
  let attempted = 0;
  adapters.voice.speak = () => { attempted += 1; return new Promise(() => {}); };
  r.enqueueSpeech(speech('gift', 'timeout'));
  await assert.rejects(r.speakNext(), { code: 'ADAPTER_ABORTED_OR_TIMEOUT' });
  assert.equal(r.enqueueSpeech(speech('gift', 'timeout')).status, 'unknown');
  await assert.rejects(r.speakNext(), { code: 'VOICE_RECOVERY_REQUIRED' });
  await r.recoverComponent('voice');
  assert.equal(await r.speakNext(), null);
  assert.equal(attempted, 1);
});

test('major voice fault cannot dispatch again until an explicit healthy recovery', async t => {
  const { runtime: r, calls, adapters } = await fixture(t);
  r.enqueueSpeech(speech('idle', 'after-repair'));
  await r.reportFault('voice', 'Repair required', { major: true });
  await assert.rejects(r.speakNext(), { code: 'VOICE_RECOVERY_REQUIRED' });
  assert.equal(r.getState().speech[0].status, 'queued');
  assert.equal(calls.filter(c => c.operation === 'speak').length, 0);
  const healthy = adapters.voice.health;
  adapters.voice.health = () => ({ healthy: false, simulated: true, evidenceId: 'still-failed' });
  await assert.rejects(r.recoverComponent('voice'), { code: 'COMPONENT_NOT_HEALTHY' });
  await assert.rejects(r.speakNext(), { code: 'VOICE_RECOVERY_REQUIRED' });
  adapters.voice.health = healthy;
  await r.recoverComponent('voice');
  assert.equal((await r.speakNext()).status, 'spoken');
  assert.equal(r.getState().health.voice.firstFailure.message, 'Repair required');
});

test('STOP before chat adapter dispatch prevents the side effect', async t => {
  const { runtime: r, calls } = await fixture(t);
  const polling = assert.rejects(r.pollChat(), { code: 'ADAPTER_ABORTED_OR_TIMEOUT' });
  await r.stop();
  await polling;
  assert.equal(calls.filter(c => c.component === 'chat' && c.operation === 'poll').length, 0);
  assert.notEqual(r.getState().health.chat.status, 'healthy');
});

test('late poll and recovery receipts cannot mark a stopped component healthy', async t => {
  for (const operation of ['poll', 'health']) {
    const { runtime: r } = await fixture(t);
    const call = r.call.bind(r);
    // Simulate STOP at the boundary after the external call settles but before
    // its caller commits the receipt, including an adapter ignoring cancellation.
    r.call = async (component, method, ...args) => {
      const receipt = await call(component, method, ...args);
      if (component === 'chat' && method === operation) await r.stop();
      return receipt;
    };
    const result = operation === 'poll' ? r.pollChat() : r.recoverComponent('chat');
    await assert.rejects(result, { code: 'RUN_NOT_ACTIVE' });
    assert.notEqual(r.getState().health.chat.status, 'healthy');
    assert.equal(r.getState().lifecycle, 'stopped');
  }
});

test('an undeclared or nonboolean adapter cost flag is rejected before voice dispatch', async t => {
  const { runtime: r, adapters, calls } = await fixture(t);
  r.enqueueSpeech(speech('idle', 'undeclared-cost'));
  for (const paid of [undefined, null, 'false', 0]) {
    if (paid === undefined) delete adapters.voice.paid;
    else adapters.voice.paid = paid;
    await assert.rejects(r.speakNext(), { code: 'ADAPTER_COST_UNDECLARED' });
    assert.equal(r.getState().speech[0].status, 'queued');
    assert.equal(calls.filter(c => c.component === 'voice' && c.operation === 'speak').length, 0);
  }
  adapters.voice.paid = false;
  assert.equal((await r.speakNext()).status, 'spoken');
});

test('an observed label without a nonempty observation cannot mark game healthy', async t => {
  const { runtime: r, adapters, calls } = await fixture(t);
  const lease = r.claimControl({ owner: 'game-executor' });
  let attempt = 0;
  for (const observation of [undefined, null, {}, [], 'command accepted', { frame: undefined }]) {
    adapters.game.execute = () => ({ status: 'observed', evidenceId: `incomplete-${++attempt}`, simulated: true, observation });
    await assert.rejects(r.executeGame({ leaseToken: lease.token, playerId: 'host-1',
      decision: { ...decision('host-1'), decisionId: `decision-${attempt}` }, action: { move: 1 } }), { code: 'GAME_EFFECT_UNOBSERVED' });
    assert.equal(r.getState().health.game.status, 'failed');
    assert.equal(r.getState().gameBusy, false);
    assert.equal(r.getState().inputUncertain, false);
    await r.recoverComponent('game');
  }
  assert.equal(calls.filter(c => c.component === 'game' && c.operation === 'release').length, 6);
});
