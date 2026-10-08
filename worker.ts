import handler from 'vinext/server/fetch-handler';
import { getGames } from './app/lib/kbo';
import { all, db, now, stmt, today } from './app/lib/server';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const response = await handler.fetch(request, env, ctx);
    const secured = new Response(response.body, response);
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('X-Frame-Options', 'DENY');
    secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (new URL(request.url).protocol === 'https:') {
      secured.headers.set('Strict-Transport-Security', 'max-age=31536000');
    }
    return secured;
  },

  // 방문자가 없는 동안에도 미정산 경기 결과를 갱신합니다.
  async scheduled(controller: ScheduledController) {
    const pending = await all<{ date: string }>(
      `SELECT g.date FROM games g JOIN bets b ON b.game_id=g.id
       WHERE b.status='pending' AND g.date<=? GROUP BY g.date
       ORDER BY MIN(g.updated_at) ASC LIMIT 7`, today(),
    );
    for (const date of new Set([today(), ...pending.map(g => g.date)])) {
      const result = await getGames(date);
      if (result.stale) console.warn('kbo_scheduled_refresh_delayed', date);
    }
    if (controller.scheduledTime % 86400000 < 120000) {
      await db().batch([
        stmt('DELETE FROM sessions WHERE expires_at<?', now()),
        stmt('DELETE FROM challenges WHERE expires_at<?', now() - 86400000),
        stmt('DELETE FROM rate_limits WHERE expires_at<?', now() - 86400000),
      ]);
    }
  },
};
