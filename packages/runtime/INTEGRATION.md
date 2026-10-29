# Runtime integration

Node.js 22 or newer. No runtime dependencies. This is a coordination core, not a game bot, speech model, platform connector, or complete broadcasting application. It does not start services on import. Original code is licensed under the [MIT License](../../LICENSE).

## Offline smoke

Run `npm test` and `npm run demo` in this package. `node demo.mjs --data-dir EMPTY_DIRECTORY` selects a new empty output directory; without that argument the demo creates a temporary directory. It runs a fixed number of synthetic operations and ends. The JSON result explicitly reports that no real game, voice, or public broadcast was produced. Delete that printed demo directory after reviewing it if you do not need the receipts.

`createSimulatedAdapters` is exported from `simulated-adapters.mjs`; `runDemo` is exported from `demo.mjs`. Their receipts are fixtures, not evidence of actual external capability.

## Root CLI integration

```js
import { createRuntime } from './packages/runtime/index.mjs';
import { createSimulatedAdapters } from './packages/runtime/simulated-adapters.mjs';

const { adapters } = createSimulatedAdapters();
const runtime = createRuntime({ directory: selectedSessionDirectory, adapters });
await runtime.start({ mode: 'demo' });
// Drive reviewed chat and bounded game actions from the application loop.
const result = await runtime.stop('operator_stop');
runtime.close();
```

The caller supplies an explicit session directory, injected drivers and, optionally, `config`. Defaults are:

```json
{
  "players": ["host-1", "host-2"],
  "rotationSeconds": 900,
  "operationTimeoutMs": 15000,
  "paidEnabled": false,
  "spendingCapUSD": null
}
```

Identifiers are neutral capability slots. The caller chooses providers, models, characters and budgets; none is preselected. The optional `now` clock exists for tests, not for inventing live evidence.

`start({mode})` accepts `demo`, `recording` or `live`. Live additionally requires `publicAuthorized: true` from the current user's authority. A demo driver cannot start recording or live modes. Construction and setup never start output. An observed `broadcast.start` receipt establishes the immutable start time. Repairs and switching scenes do not reset it. `clock()` supplies elapsed seconds, due player, actual current player, and seconds until the next scheduled rotation.

One owner lock and one atomically replaced `state.json` govern all control claims and speech dispatch in this session. Run exactly one Runtime owner per directory; other agents must send requests to that owner rather than edit the state. Multiple independent session directories must not be attached to the same external game/UI device. The application must ensure this device-to-session association. This package does not provide distributed device locking.

Opening an interrupted running session does not resume it: in-flight speech becomes `unknown` and inputs become uncertain. Stopped/interrupted sessions cannot restart. After external cleanup, use a new session directory. A lock left by a crashed process is deliberately not stolen; confirm the old process is gone and release external input/output before removing that directory's `.runtime-owner`. Never remove another live owner's lock.

## Control and player scheduling

- `claimControl({owner, ttlMs})` returns the sole lease `{token, generation, expiresAt}`.
- `assertControl(token)` validates that lease for other UI operations coordinated by the caller. `renewControl(token, ttlMs)` extends an unexpired lease.
- `executeGame({leaseToken, playerId, decision, action})` admits one bounded action and always requests input release afterwards. It requires the actual current player and a new decision ID. A failed game component must pass `recoverComponent('game')` before new actions.
- `decision` contains `playerId`, `decisionId`, `provider`, `model`, `evidenceId` and `simulated`. These identify the real producer's receipt; merely supplying strings does not prove a real model generated a decision. The integrator must validate that provenance before calling this API.
- `rotatePlayer(token)` releases game inputs and then changes actual player when the original clock says it is due. It does not react to falls or game failure. Both characters may continue speaking regardless of control ownership.
- `releaseControl(token)` requests confirmed input release before freeing the lease. Expiration alone never permits another owner to take it. An uncertain input release blocks takeover.

All UI/input users, including a director that needs a foreground window, must use the same lease. External direct clicks or other session directories bypass this protection and are outside its guarantee. When gameplay owns focus, prefer background adapter APIs for audio and production changes.

## Adapters

Each driver declares `{id, simulated, paid}` and the methods below. `paid` must explicitly be boolean `true` or `false`; omission or any other value rejects with `ADAPTER_COST_UNDECLARED` before invocation. Missing methods reject with `ADAPTER_UNCONFIGURED`. All methods receive `{signal, ...payload}` and return a Promise or plain receipt. Every receipt must include `{evidenceId, simulated}`. Every operation must honor the abort signal, bound its side effects, and make cleanup idempotent. A timeout means unknown result, not confirmed cancellation of external work.

| Driver | Methods and required result fields |
| --- | --- |
| `broadcast` | `start({mode,sessionId})` → `{active:true,mode,startedAt,observedAt}`; `setScene({scene:'hold'})`; `stop()` → `{stopped:true}` |
| `game` | `execute({action,decision,playerId})` → `{status:'observed', observation}`; `release()` → `{released:true}` |
| `voice` | `speak({deliveryId,text,characterId})` → `{status:'spoken',startedAt,endedAt}`; `stop()` → `{stopped:true}` |
| `chat` | `poll({cursor})` → `{events:[],cursor}` |
| every driver | `health()` → `{healthy:true}` |

Times are epoch milliseconds. `broadcast.start` must report the actual observed start and a fresh observation. A game receipt must include `observation` as a nonempty object containing defined observation data, such as an observed frame reference and measured change. A missing, empty, array or scalar observation is rejected; the `status:'observed'` label alone is insufficient. The driver must describe an observed effect, not just a sent command. A spoken receipt is playback evidence only; sound reaching a recording/stream remains a separate production check. Adapter receipts can be false if adapters lie; the runtime cannot independently inspect every platform.

`pollChat(cursor)` returns upstream events; it does not automatically speak arbitrary viewer content. The interaction agent reviews events, removes private/system instruction requests, selects a reply, and calls `enqueueSpeech`:

```js
runtime.enqueueSpeech({
  eventId: localEventId,
  kind: 'gift', // gift | chat | idle
  text: approvedReply,
  characterId: selectedCharacter,
  review: { accepted: true, evidenceId: reviewReceiptId },
  origin: {
    adapterId: configuredChatAdapter.id,
    platformId: platformIdentifier,
    platformEventId: canonicalUpstreamEventId,
    evidenceId: upstreamEventReceiptId,
    simulated: configuredChatAdapter.simulated
  }
});
await runtime.speakNext();
```

Chat and gift events require origin metadata. Idle dialogue does not. The runtime validates the fields and configured source, while the chat adapter must authenticate real platform origin. Do not create fake gifts with real-source metadata. Deduplication uses adapter/platform/upstream-event ID, even if local event IDs differ. Reusing a canonical ID with a different reply rejects as a collision.

Only one speech delivery can be active. A failed voice component rejects dispatch with `VOICE_RECOVERY_REQUIRED` until `recoverComponent('voice')` returns a healthy receipt; waiting items remain queued. Queued gifts precede chat and idle dialogue; an ongoing utterance is not interrupted just for a gift. Optional `expiresAt` discards stale queued items. Delivery progresses `queued → speaking → spoken` or `unknown`; unknown delivery is never automatically retried. The application should reconcile it with the original `deliveryId` at the voice adapter. Never create a new event ID to retry an uncertain gift acknowledgement. `responseLatencyMs` measures local enqueue-to-playback start; measure platform arrival-to-enqueue and actual stream latency separately.

## Health, continuity, and budgets

`reportFault(component, reason)` marks only that component failed. `{major:true}` aborts the affected operation, requests affected input/voice cleanup, and asks broadcast for a hold scene while preserving its connection. `recoverComponent(component)` requires an actual healthy receipt and retains the first failure. The runtime never automatically stops the entire session for a local fault. The surrounding application continues independent loops and decides when the programme should return from the hold scene.

`stop(reason)` is the explicit terminal operation: it aborts in-flight calls, cancels queued speech, releases input, stops voice and stops output independently. Its results distinguish confirmed stops from unknown/failed stops. The caller must await in-flight method Promises too, then call `close()`. `close()` refuses active work and does not hide failed external cleanup. An unavailable operating system or output application cannot be guaranteed to remain live.

Paid drivers require `paidEnabled:true`, a finite nonnegative `spendingCapUSD`, and a finite `maxCostUSD[method]` declaration for each chargeable method. Admission reserves that maximum before invoking the driver. An `actualCostUSD` receipt settles it; missing cost retains the reservation and is never treated as free. Cleanup must be free (`maxCostUSD.release/stop = 0` for paid drivers). The cap is a local admission guard, not a guarantee against a provider charging above its quote. No automatic recharge is performed. Model calls performed outside these adapters need their own budget admission before invocation.

No credentials, provider configuration or secrets belong in this package or session receipts. Configure external services through the application's local secret mechanism. This version intentionally omits platform login, stream destinations, game-specific hooks, content moderation models, TTS providers and real media capture. Those require separate tested adapters.
