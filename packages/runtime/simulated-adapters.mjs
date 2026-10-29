/** Synthetic receipts only. No UI, network, sound, game, or media output. */
export function createSimulatedAdapters({ now = Date.now, events = [] } = {}) {
  const calls = [];
  let sequence = 0;
  const receipt = (component, operation, fields = {}) => {
    calls.push({ component, operation });
    return { evidenceId: `simulated-${++sequence}`, simulated: true, ...fields };
  };
  const base = component => ({
    id: `simulated-${component}`, simulated: true, paid: false,
    health: () => receipt(component, 'health', { healthy: true }),
  });
  return {
    calls,
    adapters: {
      game: { ...base('game'),
        execute: ({ playerId, action }) => receipt('game', 'execute', { status: 'observed', playerId,
          observation: { synthetic: true, action, frame: sequence + 1 } }),
        release: () => receipt('game', 'release', { released: true }),
      },
      voice: { ...base('voice'),
        speak: ({ deliveryId }) => receipt('voice', 'speak', { status: 'spoken', deliveryId,
          startedAt: now(), endedAt: now(), audioProduced: false }),
        stop: () => receipt('voice', 'stop', { stopped: true }),
      },
      broadcast: { ...base('broadcast'),
        start: ({ mode }) => receipt('broadcast', 'start', { active: true, mode, startedAt: now(), observedAt: now(), mediaProduced: false }),
        setScene: ({ scene }) => receipt('broadcast', 'setScene', { scene }),
        stop: () => receipt('broadcast', 'stop', { stopped: true }),
      },
      chat: { ...base('chat'),
        poll: () => receipt('chat', 'poll', { events, cursor: null }),
      },
    },
  };
}
