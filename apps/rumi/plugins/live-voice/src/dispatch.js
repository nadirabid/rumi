/**
 * Ordered voice submissions share one agent-running interval and its final outcome.
 * @param {object} options - Agent resolution, message construction, interval reporting and lifetime callbacks.
 * @returns {Function} Submit a request with captured content; returns the shared interval completion.
 */
export function createVoiceDispatcher({ resolveAgent, createMessages, flush, outcome, finished, closed, accepted = () => {}, failed = () => {}, timeoutMs = 10000 }) {
  let interval = null;
  const admit = async (task, current) => {
    let timer;
    try {
      const [agent, content] = await Promise.race([
        Promise.all([current.ready, task.content]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The request was not accepted in time. Please repeat it.')), timeoutMs); }),
      ]);
      if (closed()) return;
      if (current.firstSeq === null) current.firstSeq = agent.session.seq;
      const { message, reference } = createMessages(task.text, content);
      if (reference) agent.inject(reference);
      agent.steer(message);
      accepted(task.delegationId);
    } catch (error) {
      failed(task.delegationId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally { clearTimeout(timer); }
  };
  return task => {
    if (closed()) return Promise.resolve();
    if (!interval) {
      const current = { pending: Promise.resolve(), ready: resolveAgent(), firstSeq: null, completion: null };
      interval = current;
      current.pending = admit(task, current);
      current.completion = (async () => {
        try {
          await current.pending;
          const agent = await current.ready;
          while (true) {
            const submitted = current.pending;
            await submitted;
            await agent.whenIdle();
            if (submitted !== current.pending) continue;
            await flush(agent.session);
            if (submitted !== current.pending) continue;
            const result = outcome(agent.session, current.firstSeq);
            interval = null;
            finished({ ok: result.reason?.kind !== 'error', text: result.text });
            return;
          }
        } catch (error) {
          interval = null;
          finished({ ok: false, text: error instanceof Error ? error.message : String(error) });
        }
      })();
    } else {
      const current = interval;
      current.pending = current.pending.then(() => admit(task, current));
      // The interval reports this rejection after the running agent settles.
      void current.pending.catch(() => {});
    }
    return interval.completion;
  };
}
