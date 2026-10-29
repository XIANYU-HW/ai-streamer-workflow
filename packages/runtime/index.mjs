import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const components = ['game', 'voice', 'broadcast', 'chat'];
const priority = { gift: 0, chat: 1, idle: 2 };
const terminal = new Set(['stopped', 'interrupted']);
const fail = (code, detail = code) => Object.assign(new Error(detail), { code });
const need = (condition, code, detail) => { if (!condition) throw fail(code, detail); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** No background loops or external services start when this object is created. */
export function createRuntime(options) { return new Runtime(options); }

export class Runtime {
  constructor({ directory, config = {}, adapters = {}, now = Date.now } = {}) {
    need(typeof directory === 'string' && directory.length > 0, 'DATA_DIRECTORY_REQUIRED');
    this.directory = resolve(directory);
    this.now = now;
    this.adapters = adapters;
    this.controllers = new Map();
    this.closed = false;
    const settings = {
      players: ['host-1', 'host-2'], rotationSeconds: 900, operationTimeoutMs: 15000,
      paidEnabled: false, spendingCapUSD: null, ...config,
    };
    need(Array.isArray(settings.players) && settings.players.length > 0 &&
      settings.players.every(p => typeof p === 'string' && p) &&
      new Set(settings.players).size === settings.players.length, 'INVALID_PLAYERS');
    need(finite(settings.rotationSeconds) && settings.rotationSeconds > 0, 'INVALID_ROTATION');
    need(finite(settings.operationTimeoutMs) && settings.operationTimeoutMs > 0, 'INVALID_TIMEOUT');
    need(typeof settings.paidEnabled === 'boolean', 'INVALID_BUDGET');
    need(!settings.paidEnabled || (finite(settings.spendingCapUSD) && settings.spendingCapUSD >= 0), 'FINITE_SPENDING_CAP_REQUIRED');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.file = join(this.directory, 'state.json');
    this.lock = join(this.directory, '.runtime-owner');
    try { this.lockFd = openSync(this.lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw fail('DIRECTORY_ALREADY_OWNED'); throw error; }
    try {
      writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, owner: randomUUID() }));
      if (existsSync(this.file)) {
        this.state = JSON.parse(readFileSync(this.file, 'utf8'));
        need(this.state.schemaVersion === 1, 'UNSUPPORTED_STATE');
        need(Object.keys(config).length === 0 || hash(this.state.config) === hash(settings), 'EXISTING_CONFIG_MISMATCH');
        if (!['ready', 'stopped', 'interrupted'].includes(this.state.lifecycle)) {
          this.update(s => {
            s.lifecycle = 'interrupted';
            s.inputUncertain = true;
            s.gameBusy = false;
            s.controlReleasing = false;
            for (const job of s.speech) if (job.status === 'speaking') job.status = 'unknown';
            s.activeSpeechId = null;
            s.recoveryNote = 'Owner restarted; no automatic replay or resumption. Inspect external drivers.';
          });
        }
      } else {
        this.state = {
          schemaVersion: 1, sessionId: randomUUID(), revision: 0, lifecycle: 'ready', mode: null,
          config: settings, actualStartedAt: null, stopReason: null, lease: null, leaseGeneration: 0,
          currentPlayer: settings.players[0], rotationIndex: 0, gameBusy: false,
          controlReleasing: false, inputUncertain: false, decisions: {},
          speech: [], activeSpeechId: null, budget: { spentUSD: 0, reservations: {} },
          health: Object.fromEntries(components.map(c => [c, { status: 'unconfigured', firstFailure: null }])),
        };
        this.write(this.state);
      }
    } catch (error) { closeSync(this.lockFd); unlinkSync(this.lock); throw error; }
  }

  write(state) {
    const temp = join(this.directory, `.state-${randomUUID()}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temp, this.file); }
    catch (error) { unlinkSync(temp); throw error; }
  }

  update(change) {
    need(!this.closed, 'RUNTIME_CLOSED');
    const next = structuredClone(this.state);
    const result = change(next);
    next.revision += 1;
    this.write(next);
    this.state = next;
    return result;
  }

  getState() { return structuredClone(this.state); }

  active() { need(!this.closed && this.state.lifecycle === 'running', 'RUN_NOT_ACTIVE'); }

  driver(component, method) {
    const adapter = this.adapters[component];
    need(adapter && typeof adapter.id === 'string' && typeof adapter.simulated === 'boolean' &&
      typeof adapter[method] === 'function', 'ADAPTER_UNCONFIGURED', `${component}.${method} is not configured`);
    need(typeof adapter.paid === 'boolean', 'ADAPTER_COST_UNDECLARED', `${component} must explicitly declare paid: true or false`);
    if (this.state.mode) need(adapter.simulated === (this.state.mode === 'demo'), 'ADAPTER_MODE_MISMATCH');
    return adapter;
  }

  evidence(component, receipt) {
    need(receipt && typeof receipt.evidenceId === 'string' && receipt.evidenceId &&
      receipt.simulated === this.adapters[component].simulated, 'INVALID_ADAPTER_RECEIPT');
    return receipt;
  }

  fault(component, error) {
    need(components.includes(component), 'INVALID_COMPONENT');
    const entry = { at: this.now(), code: error.code || 'ADAPTER_FAILED', message: String(error.message || error).slice(0, 400) };
    this.update(s => {
      s.health[component].status = 'failed';
      s.health[component].firstFailure ??= entry;
      s.health[component].lastFailure = entry;
    });
  }

  reserve(component, method, adapter) {
    if (!adapter.paid) return null;
    const { paidEnabled, spendingCapUSD } = this.state.config;
    need(paidEnabled && finite(spendingCapUSD), 'PAID_CALLS_DISABLED');
    const amount = adapter.maxCostUSD?.[method];
    need(finite(amount) && amount >= 0, 'MAX_COST_REQUIRED');
    const id = randomUUID();
    this.update(s => {
      const reserved = Object.values(s.budget.reservations).reduce((n, r) => n + r.maxCostUSD, 0);
      need(s.budget.spentUSD + reserved + amount <= spendingCapUSD, 'SPENDING_CAP_REACHED');
      s.budget.reservations[id] = { component, method, maxCostUSD: amount, status: 'reserved' };
    });
    return id;
  }

  async call(component, method, payload = {}, { cleanup = false } = {}) {
    const adapter = this.driver(component, method);
    // Cleanup methods must be free; never let a budget gate prevent an input release.
    if (cleanup) need(!adapter.paid || adapter.maxCostUSD?.[method] === 0, 'CLEANUP_MUST_BE_FREE');
    const reservation = cleanup ? null : this.reserve(component, method, adapter);
    const controller = new AbortController();
    this.controllers.set(controller, { component, cleanup });
    let timer;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(fail('ADAPTER_ABORTED_OR_TIMEOUT')), { once: true });
      timer = setTimeout(() => controller.abort(), this.state.config.operationTimeoutMs);
    });
    try {
      const receipt = await Promise.race([
        Promise.resolve().then(() => {
          need(!controller.signal.aborted, 'ADAPTER_ABORTED_OR_TIMEOUT');
          return adapter[method]({ ...payload, signal: controller.signal });
        }), aborted,
      ]);
      this.evidence(component, receipt);
      if (reservation && finite(receipt.actualCostUSD) && receipt.actualCostUSD >= 0) {
        this.update(s => {
          s.budget.spentUSD += receipt.actualCostUSD;
          delete s.budget.reservations[reservation];
        });
      }
      return receipt;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      // Missing cost or unknown delivery deliberately keeps its maximum reservation.
    }
  }

  async start({ mode = 'demo', publicAuthorized = false } = {}) {
    need(this.state.lifecycle === 'ready', 'NEW_SESSION_REQUIRED');
    need(['demo', 'recording', 'live'].includes(mode), 'INVALID_MODE');
    need(mode !== 'live' || publicAuthorized === true, 'PUBLIC_BROADCAST_AUTHORIZATION_REQUIRED');
    this.update(s => { s.mode = mode; s.lifecycle = 'starting'; });
    try {
      const receipt = await this.call('broadcast', 'start', { mode, sessionId: this.state.sessionId });
      need(this.state.lifecycle === 'starting', 'START_INTERRUPTED');
      need(receipt.active === true && receipt.mode === mode && finite(receipt.startedAt) &&
        finite(receipt.observedAt) && receipt.startedAt <= receipt.observedAt && receipt.observedAt <= this.now() &&
        this.now() - receipt.observedAt <= this.state.config.operationTimeoutMs, 'OUTPUT_NOT_OBSERVED');
      this.update(s => {
        s.actualStartedAt = receipt.startedAt;
        s.lifecycle = 'running';
        s.health.broadcast = { ...s.health.broadcast, status: 'healthy', receipt };
      });
      return receipt;
    } catch (error) {
      this.fault('broadcast', error);
      // A failed or timed-out external start may have produced output; require explicit stop.
      this.update(s => { if (s.lifecycle === 'starting') s.lifecycle = 'start-unknown'; });
      throw error;
    }
  }

  clock() {
    const s = this.state;
    if (s.actualStartedAt === null) return { elapsedSeconds: null, duePlayer: s.currentPlayer, remainingSeconds: null };
    const elapsedSeconds = Math.max(0, (this.now() - s.actualStartedAt) / 1000);
    const rotationIndex = Math.floor(elapsedSeconds / s.config.rotationSeconds);
    return { elapsedSeconds, rotationIndex, duePlayer: s.config.players[rotationIndex % s.config.players.length],
      currentPlayer: s.currentPlayer, remainingSeconds: s.config.rotationSeconds - elapsedSeconds % s.config.rotationSeconds };
  }

  claimControl({ owner, ttlMs = 15000 }) {
    this.active();
    need(typeof owner === 'string' && owner && finite(ttlMs) && ttlMs > 0, 'INVALID_LEASE');
    return this.update(s => {
      need(!s.lease && !s.inputUncertain && !s.gameBusy && !s.controlReleasing, 'CONTROL_ALREADY_OWNED_OR_UNCERTAIN');
      s.leaseGeneration += 1;
      s.lease = { owner, token: randomUUID(), generation: s.leaseGeneration, expiresAt: this.now() + ttlMs };
      return structuredClone(s.lease);
    });
  }

  assertControl(token) {
    this.active();
    const lease = this.state.lease;
    need(lease && lease.token === token && lease.expiresAt > this.now() &&
      !this.state.controlReleasing && !this.state.inputUncertain, 'CONTROL_LEASE_INVALID');
    return structuredClone(lease);
  }

  renewControl(token, ttlMs = 15000) {
    this.assertControl(token);
    need(finite(ttlMs) && ttlMs > 0, 'INVALID_LEASE');
    this.update(s => { s.lease.expiresAt = this.now() + ttlMs; });
  }

  async releaseInputs() {
    try {
      const receipt = await this.call('game', 'release', {}, { cleanup: true });
      need(receipt.released === true, 'INPUT_RELEASE_UNCONFIRMED');
      this.update(s => { s.inputUncertain = false; s.lastInputRelease = receipt; });
      return receipt;
    } catch (error) {
      this.update(s => { s.inputUncertain = true; });
      this.fault('game', error);
      throw error;
    }
  }

  async releaseControl(token) {
    this.update(s => {
      need(s.lease?.token === token && !s.gameBusy && !s.controlReleasing, 'CONTROL_RELEASE_REJECTED');
      s.controlReleasing = true;
    });
    try {
      await this.releaseInputs();
      this.update(s => { s.lease = null; });
    } finally { this.update(s => { s.controlReleasing = false; }); }
  }

  async rotatePlayer(token) {
    this.assertControl(token);
    const clock = this.clock();
    if (clock.rotationIndex === this.state.rotationIndex) return this.state.currentPlayer;
    need(!this.state.gameBusy, 'GAME_BUSY');
    this.update(s => { s.controlReleasing = true; });
    try {
      await this.releaseInputs();
      this.active();
      this.update(s => { s.currentPlayer = clock.duePlayer; s.rotationIndex = clock.rotationIndex; });
      return this.state.currentPlayer;
    } finally { this.update(s => { s.controlReleasing = false; }); }
  }

  async executeGame({ leaseToken, playerId, decision, action }) {
    this.assertControl(leaseToken);
    need(playerId === this.state.currentPlayer && this.clock().rotationIndex === this.state.rotationIndex, 'PLAYER_ROTATION_REQUIRED');
    need(decision && decision.playerId === playerId && ['decisionId', 'provider', 'model', 'evidenceId'].every(k =>
      typeof decision[k] === 'string' && decision[k]) && decision.simulated === (this.state.mode === 'demo'), 'INVALID_DECISION');
    this.driver('game', 'execute');
    this.update(s => {
      need(!s.gameBusy && s.health.game.status !== 'failed', 'GAME_BUSY_OR_FAILED');
      need(!s.decisions[decision.decisionId], 'DECISION_ALREADY_USED');
      s.decisions[decision.decisionId] = { playerId, evidenceId: decision.evidenceId };
      s.gameBusy = true;
    });
    let result, error;
    try {
      result = await this.call('game', 'execute', { action, decision, playerId });
      need(result.status === 'observed' && result.observation && typeof result.observation === 'object' &&
        !Array.isArray(result.observation) && Object.values(result.observation).some(value => value !== undefined),
      'GAME_EFFECT_UNOBSERVED');
      this.active();
      this.update(s => { s.health.game = { ...s.health.game, status: 'healthy', receipt: result }; });
    } catch (caught) { error = caught; this.fault('game', caught); }
    try { await this.releaseInputs(); } catch (caught) { error ??= caught; }
    this.update(s => { s.gameBusy = false; });
    if (error) throw error;
    return result;
  }

  enqueueSpeech({ eventId, kind, text, characterId, review, origin, expiresAt = null }) {
    this.active();
    need(typeof eventId === 'string' && eventId && Object.hasOwn(priority, kind) && typeof text === 'string' && text.trim() &&
      typeof characterId === 'string' && characterId && review?.accepted === true &&
      typeof review.evidenceId === 'string' && review.evidenceId, 'SPEECH_REVIEW_REQUIRED');
    need(expiresAt === null || finite(expiresAt), 'INVALID_EXPIRY');
    let key = `event:${eventId}`;
    if (kind === 'gift' || kind === 'chat') {
      const adapter = this.driver('chat', 'poll');
      need(origin?.adapterId === adapter.id && origin.simulated === adapter.simulated &&
        ['platformId', 'platformEventId', 'evidenceId'].every(k => typeof origin[k] === 'string' && origin[k]), 'EVENT_ORIGIN_REQUIRED');
      key = JSON.stringify([origin.adapterId, origin.platformId, origin.platformEventId]);
    }
    const fingerprint = hash({ kind, text, characterId });
    const old = this.state.speech.find(job => job.key === key);
    if (old) { need(old.fingerprint === fingerprint, 'EVENT_ID_COLLISION'); return structuredClone(old); }
    return this.update(s => {
      const job = { id: randomUUID(), eventId, key, fingerprint, kind, text, characterId, review, origin,
        expiresAt, status: 'queued', createdAt: this.now(), sequence: s.speech.length };
      s.speech.push(job);
      return structuredClone(job);
    });
  }

  async speakNext() {
    this.active();
    need(!this.state.activeSpeechId, 'VOICE_BUSY');
    need(this.state.health.voice.status !== 'failed', 'VOICE_RECOVERY_REQUIRED');
    this.driver('voice', 'speak');
    const job = this.update(s => {
      for (const queued of s.speech) if (queued.status === 'queued' && queued.expiresAt !== null && queued.expiresAt <= this.now()) queued.status = 'expired';
      const next = s.speech.filter(j => j.status === 'queued').sort((a, b) => priority[a.kind] - priority[b.kind] || a.sequence - b.sequence)[0];
      if (!next) return null;
      next.status = 'speaking';
      s.activeSpeechId = next.id;
      return structuredClone(next);
    });
    if (!job) return null;
    try {
      const receipt = await this.call('voice', 'speak', { deliveryId: job.id, text: job.text, characterId: job.characterId });
      need(receipt.status === 'spoken' && finite(receipt.startedAt) && finite(receipt.endedAt) &&
        receipt.endedAt >= receipt.startedAt, 'VOICE_DELIVERY_UNKNOWN');
      this.active();
      this.update(s => {
        Object.assign(s.speech.find(j => j.id === job.id), { status: 'spoken', receipt,
          responseLatencyMs: Math.max(0, receipt.startedAt - job.createdAt) });
        s.health.voice = { ...s.health.voice, status: 'healthy', receipt };
      });
      return this.state.speech.find(j => j.id === job.id);
    } catch (error) {
      this.update(s => { s.speech.find(j => j.id === job.id).status = 'unknown'; });
      this.fault('voice', error);
      throw error;
    } finally { this.update(s => { s.activeSpeechId = null; }); }
  }

  async pollChat(cursor = null) {
    this.active();
    try {
      const receipt = await this.call('chat', 'poll', { cursor });
      need(Array.isArray(receipt.events), 'INVALID_CHAT_RECEIPT');
      this.active();
      this.update(s => { s.health.chat = { ...s.health.chat, status: 'healthy', receipt: { evidenceId: receipt.evidenceId } }; });
      return receipt;
    } catch (error) { this.fault('chat', error); throw error; }
  }

  async reportFault(component, reason, { major = false } = {}) {
    this.active();
    this.fault(component, fail('REPORTED_FAULT', reason));
    if (!major) return;
    for (const [controller, operation] of this.controllers) {
      if (operation.component === component && !operation.cleanup) controller.abort();
    }
    if (component === 'game') await this.releaseInputs().catch(() => {});
    if (component === 'voice') await this.call('voice', 'stop', {}, { cleanup: true }).catch(error => this.fault('voice', error));
    // A hold scene preserves the output connection. No broadcast.stop here.
    try { await this.call('broadcast', 'setScene', { scene: 'hold' }); }
    catch (error) { this.fault('broadcast', error); }
  }

  async recoverComponent(component) {
    this.active();
    need(components.includes(component), 'INVALID_COMPONENT');
    const receipt = await this.call(component, 'health');
    need(receipt.healthy === true, 'COMPONENT_NOT_HEALTHY');
    this.active();
    this.update(s => { s.health[component] = { ...s.health[component], status: 'healthy', receipt }; });
    return receipt;
  }

  async stop(reason = 'operator_stop') {
    if (this.state.lifecycle === 'stopped') return this.getState().stopResults;
    need(!this.closed, 'RUNTIME_CLOSED');
    if (this.stopPromise) return this.stopPromise;
    this.update(s => {
      s.lifecycle = 'stopping';
      s.stopReason ??= reason;
      for (const job of s.speech) {
        if (job.status === 'queued') job.status = 'cancelled';
        if (job.status === 'speaking') job.status = 'unknown';
      }
    });
    for (const [controller] of this.controllers) controller.abort();
    this.stopPromise = (async () => {
      const actions = [['game', 'release'], ['voice', 'stop'], ['broadcast', 'stop']];
      const results = await Promise.all(actions.map(async ([component, method]) => {
        try {
          const receipt = await this.call(component, method, {}, { cleanup: true });
          need(component === 'game' ? receipt.released === true : receipt.stopped === true, 'STOP_UNCONFIRMED');
          return [component, { confirmed: true, receipt }];
        } catch (error) { this.fault(component, error); return [component, { confirmed: false, code: error.code || 'STOP_FAILED' }]; }
      }));
      this.update(s => {
        s.stopResults = Object.fromEntries(results);
        s.inputUncertain = !s.stopResults.game.confirmed;
        if (!s.inputUncertain) s.lease = null;
        s.lifecycle = 'stopped';
      });
      return this.getState().stopResults;
    })();
    return this.stopPromise;
  }

  close() {
    need(['ready', ...terminal].includes(this.state.lifecycle) && this.controllers.size === 0 && !this.state.gameBusy &&
      !this.state.activeSpeechId, 'STOP_AND_SETTLE_BEFORE_CLOSE');
    if (!this.closed) { closeSync(this.lockFd); unlinkSync(this.lock); this.closed = true; }
  }
}
