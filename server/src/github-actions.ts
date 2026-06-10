// "clear notification" — mark github notifications read via gh api.

import { sh } from './util.js';

const THREAD_ID_RE = /^[\w-]+$/;

/** body {id} → mark one thread read (204); body {all:true} → mark all read (202/205).
 *  badRequest marks client-input failures so the route can answer 400, not 500. */
export async function markNotificationRead(
  body: any,
): Promise<{ ok: boolean; error?: string; badRequest?: boolean }> {
  try {
    if (body?.id !== undefined && body?.id !== null) {
      const id = body.id;
      if (typeof id !== 'string' || !THREAD_ID_RE.test(id)) {
        return { ok: false, badRequest: true, error: 'invalid notification id' };
      }
      await sh('gh', ['api', '-X', 'PATCH', `notifications/threads/${id}`]);
      return { ok: true };
    }
    if (body?.all === true) {
      await sh('gh', ['api', '-X', 'PUT', 'notifications', '-F', 'read=true']);
      return { ok: true };
    }
    return { ok: false, badRequest: true, error: 'id or all required' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
