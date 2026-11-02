import { ART_CHANNEL, CLIENT_NAME, TvConfig, artRequestMessage, channelUrl, parseArtReply, parseFrame } from './protocol';

/**
 * One-shot request on The Frame's art channel: open socket → wait for ready → send → await
 * the matching d2d_service_message → close. Rejects on timeout (some firmware never answers).
 */
export function artRequest(
  cfg: TvConfig,
  request: string,
  extra: Record<string, unknown> = {},
  timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const { message, requestId } = artRequestMessage(request, extra);
    const ws = new WebSocket(channelUrl(cfg, ART_CHANNEL, CLIENT_NAME));
    let sent = false;
    let done = false;
    let readyFallback: ReturnType<typeof setTimeout> | undefined;

    const finish = (err: Error | null, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(readyFallback);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(value!);
    };
    const send = () => {
      if (!sent && !done) {
        sent = true;
        ws.send(message);
      }
    };

    const timer = setTimeout(() => finish(new Error('Art Mode API did not respond')), timeoutMs);

    ws.onmessage = (ev) => {
      const frame = parseFrame(typeof ev.data === 'string' ? ev.data : '');
      if (!frame) return;
      if (frame.event === 'ms.channel.ready') send();
      else if (frame.event === 'ms.channel.connect') {
        // Most sets follow connect with ready; don't wait forever if this one doesn't.
        readyFallback = setTimeout(send, 800);
      } else if (frame.event === 'ms.channel.unauthorized') {
        finish(new Error('Art channel unauthorized'));
      } else {
        const reply = parseArtReply(frame, requestId);
        if (!reply) return;
        if (reply.event === 'error') finish(new Error(`Art Mode error: ${String(reply.error_code ?? 'unknown')}`));
        else finish(null, reply);
      }
    };
    ws.onerror = () => finish(new Error('Art channel connection failed'));
    ws.onclose = () => finish(new Error('Art channel closed'));
  });
}

export async function getArtMode(cfg: TvConfig): Promise<'on' | 'off'> {
  const reply = await artRequest(cfg, 'get_artmode_status');
  return reply.value === 'on' ? 'on' : 'off';
}

export async function setArtMode(cfg: TvConfig, on: boolean): Promise<void> {
  await artRequest(cfg, 'set_artmode_status', { value: on ? 'on' : 'off' });
}

/** Flip Art Mode; returns the new state. */
export async function toggleArtMode(cfg: TvConfig): Promise<'on' | 'off'> {
  const current = await getArtMode(cfg);
  const next = current === 'on' ? 'off' : 'on';
  await setArtMode(cfg, next === 'on');
  return next;
}
