import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express } from 'express';
import { config } from './config.js';
import { artifactsRouter } from './api/routes/artifacts.js';
import { authRouter } from './api/routes/auth.js';
import { digestRouter } from './api/routes/digest.js';
import { jobsRouter } from './api/routes/jobs.js';
import { linksRouter } from './api/routes/links.js';
import { runsRouter, specsRouter } from './api/routes/specs.js';
import { usersRouter } from './api/routes/users.js';
import { errorHandler, notFoundHandler, requestLogger } from './api/middleware.js';
import { asr } from './providers/asr.js';
import { llm } from './providers/llm.js';
import { vision } from './providers/vision.js';
import { queueDepth } from './queue/queue.js';
import { db } from './db/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locates the built PWA so one process can serve the API and the app. */
function webDistPath(): string | null {
  const candidates = [
    path.resolve(here, '..', '..', 'web', 'dist'),
    path.resolve(here, '..', '..', '..', 'web', 'dist'),
    path.resolve(process.cwd(), 'packages', 'web', 'dist'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) ?? null;
}

export function createApp(): Express {
  const cfg = config();
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser callers send no Origin header.
        if (!origin) return callback(null, true);
        const allowed = [cfg.publicUrl, ...cfg.corsOrigins];
        callback(null, allowed.includes(origin));
      },
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  // The PWA's share target posts a form, not JSON.
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(requestLogger);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // ── Health & capability reporting ─────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ ok: true, at: new Date().toISOString() });
  });

  /**
   * Tells the client which parts of the pipeline are live on this deployment,
   * so the UI can be honest about what will and will not happen to a link
   * rather than silently degrading (spec §6.5 "Graceful failure").
   */
  app.get('/v1/capabilities', (_req, res) => {
    res.json({
      analysis: { provider: llm().name, live: llm().live },
      speechToText: { provider: asr().name, live: asr().live },
      vision: { provider: vision().name, live: vision().live },
      browserAgent: cfg.enableBrowserAgent,
      autonomousImplementation: cfg.enableAutonomousImplementation,
      signupOpen: cfg.allowSignup,
      pushPublicKey: cfg.vapidPublicKey || null,
      budgets: {
        maxUsdPerLink: cfg.maxUsdPerLink,
        maxUsdPerUserPerDay: cfg.maxUsdPerUserPerDay,
      },
    });
  });

  app.get('/v1/metrics', (_req, res) => {
    const counts = db().prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all() as {
      state: string;
      n: number;
    }[];
    res.json({
      queue: queueDepth(),
      jobsByState: Object.fromEntries(counts.map((row) => [row.state, row.n])),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // ── API ───────────────────────────────────────────────────────────────────
  app.use('/v1/auth', authRouter);
  app.use('/v1/links', linksRouter);
  app.use('/v1/library', linksRouter);
  app.use('/v1/jobs', jobsRouter);
  app.use('/v1/specs', specsRouter);
  app.use('/v1/runs', runsRouter);
  app.use('/v1/users', usersRouter);
  app.use('/v1/artifacts', artifactsRouter);
  app.use('/v1/digest', digestRouter);

  // ── Static PWA ────────────────────────────────────────────────────────────
  const dist = webDistPath();
  if (dist) {
    app.use(
      express.static(dist, {
        // The service worker must never be served stale, or an install can get
        // stuck on an old build.
        setHeaders(res, filePath) {
          if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    // SPA fallback for client-side routes, but never for API paths.
    app.get(/^\/(?!v1\/|health\b).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
