import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { rolesRouter } from './modules/roles/roles.routes.js';
import { genresRouter } from './modules/genres/genres.routes.js';
import { peopleRouter } from './modules/people/people.routes.js';
import { moviesRouter } from './modules/movies/movies.routes.js';
import { seriesRouter } from './modules/series/series.routes.js';
import { collectionsRouter } from './modules/collections/collections.routes.js';
import { mediaRouter } from './modules/media/media.routes.js';
import { playbackRouter } from './modules/playback/playback.routes.js';
import { watchlistRouter } from './modules/watchlist/watchlist.routes.js';
import { watchHistoryRouter } from './modules/watch-history/watch-history.routes.js';
import { reviewsRouter } from './modules/reviews/reviews.routes.js';
import { plansRouter } from './modules/plans/plans.routes.js';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes.js';
import { couponsRouter } from './modules/coupons/coupons.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { auditLogsRouter } from './modules/audit-logs/audit-logs.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { jobsRouter } from './jobs/jobs.routes.js';

/** All versioned API routers. Each module router declares full paths relative to API_PREFIX. */
export function createApiRouter(): Router {
  const router = Router();
  for (const r of [
    authRouter,
    usersRouter,
    rolesRouter,
    genresRouter,
    peopleRouter,
    moviesRouter,
    seriesRouter,
    collectionsRouter,
    mediaRouter,
    playbackRouter,
    watchlistRouter,
    watchHistoryRouter,
    reviewsRouter,
    plansRouter,
    subscriptionsRouter,
    couponsRouter,
    paymentsRouter,
    notificationsRouter,
    adminRouter,
    auditLogsRouter,
    settingsRouter,
    jobsRouter,
  ]) {
    router.use(r);
  }
  return router;
}
