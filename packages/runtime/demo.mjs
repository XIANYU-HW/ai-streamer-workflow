import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './index.mjs';
import { createSimulatedAdapters } from './simulated-adapters.mjs';

/** Finite simulated coordination smoke. Never reads a previous project or account. */
export async function runDemo({ directory } = {}) {
  const dataDirectory = directory ? resolve(directory) : mkdtempSync(join(tmpdir(), 'ai-streamer-demo-'));
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  if (readdirSync(dataDirectory).length) throw new Error('Demo requires a new empty data directory.');
  let time = 1000000;
  const now = () => time;
  const { adapters, calls } = createSimulatedAdapters({ now });
  const runtime = createRuntime({ directory: dataDirectory, adapters, now });
  try {
    await runtime.start({ mode: 'demo' });
    const lease = runtime.claimControl({ owner: 'game-executor', ttlMs: 1000000 });
    const review = { accepted: true, evidenceId: 'simulated-editor-review' };
    const source = id => ({ adapterId: adapters.chat.id, platformId: 'simulated-platform',
      platformEventId: id, simulated: true, evidenceId: `simulated-event-${id}` });
    runtime.enqueueSpeech({ eventId: 'idle-1', kind: 'idle', text: 'A quiet moment to discuss the next move.', characterId: 'host-1', review });
    runtime.enqueueSpeech({ eventId: 'chat-1', kind: 'chat', text: 'Thanks for the suggestion.', characterId: 'host-2', review, origin: source('chat-1') });
    const gift = { eventId: 'gift-1', kind: 'gift', text: 'Thank you for the gift.', characterId: 'host-1', review, origin: source('gift-1') };
    runtime.enqueueSpeech(gift);
    runtime.enqueueSpeech({ ...gift, eventId: 'same-platform-event' });
    const order = [];
    for (let i = 0; i < 3; i++) order.push((await runtime.speakNext()).kind);
    const decision = playerId => ({ playerId, provider: 'simulated', model: 'synthetic-fixture',
      decisionId: `simulated-decision-${playerId}`, evidenceId: `simulated-model-${playerId}`, simulated: true });
    await runtime.executeGame({ leaseToken: lease.token, playerId: 'host-1', decision: decision('host-1'), action: { syntheticMove: 1 } });
    time += 900000;
    await runtime.rotatePlayer(lease.token);
    await runtime.executeGame({ leaseToken: lease.token, playerId: 'host-2', decision: decision('host-2'), action: { syntheticMove: 2 } });
    await runtime.reportFault('chat', 'Synthetic connection interruption');
    await runtime.recoverComponent('chat');
    const stopResults = await runtime.stop('demo_complete');
    const state = runtime.getState();
    return {
      simulated: true, realGamePlayed: false, realSpeechPlayed: false, publicBroadcastStarted: false,
      dataDirectory, queueOrder: order, canonicalGiftCount: state.speech.filter(j => j.kind === 'gift').length,
      currentPlayer: state.currentPlayer, actualStartedAt: state.actualStartedAt,
      retainedFirstFault: !!state.health.chat.firstFailure, lifecycle: state.lifecycle,
      simulatedStopsConfirmed: Object.values(stopResults).every(r => r.confirmed), simulatedAdapterCalls: calls.length,
    };
  } finally {
    if (runtime.getState().lifecycle !== 'stopped') await runtime.stop('demo_cleanup');
    runtime.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--data-dir')) throw new Error('Usage: node demo.mjs [--data-dir EMPTY_DIRECTORY]');
  console.log(JSON.stringify(await runDemo({ directory: args[1] }), null, 2));
}
