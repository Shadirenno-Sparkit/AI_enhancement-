import fs from 'node:fs';
import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db/index.js';
import { pruneRateLimitBuckets } from './api/middleware.js';
import { asr } from './providers/asr.js';
import { llm } from './providers/llm.js';
import { vision } from './providers/vision.js';
import { Worker } from './queue/worker.js';
import { createLogger, errorMessage } from './util/logger.js';

const log = createLogger('boot');

async function main(): Promise<void> {
  const cfg = config();

  for (const dir of [cfg.storagePath, cfg.artifactRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db(); // opens the database and applies the schema

  const app = createApp();
  const worker = new Worker();
  worker.start();

  const prune = setInterval(() => pruneRateLimitBuckets(), 15 * 60 * 1000);
  prune.unref?.();

  const server = app.listen(cfg.port, () => {
    log.info(`AI Enhancement App listening on http://localhost:${cfg.port}`, {
      env: cfg.env,
      analysis: `${llm().name}${llm().live ? '' : ' (offline analyzer)'}`,
      speechToText: `${asr().name}${asr().live ? '' : ' (disabled)'}`,
      vision: `${vision().name}${vision().live ? '' : ' (disabled)'}`,
      autonomy: cfg.enableAutonomousImplementation ? cfg.defaultTrustPosture : 'disabled',
    });
    if (!llm().live) {
      log.warn(
        'Running without ANTHROPIC_API_KEY: links are still captured, extracted and specced by the ' +
          'offline analyzer. Add a key to .env for full-quality analysis.',
      );
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received — shutting down`);
    clearInterval(prune);
    // Stop accepting work, let in-flight items finish, then close the socket.
    await worker.stop();
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { error: errorMessage(reason) });
  });
}

main().catch((err) => {
  log.error('failed to start', { error: errorMessage(err) });
  process.exit(1);
});
