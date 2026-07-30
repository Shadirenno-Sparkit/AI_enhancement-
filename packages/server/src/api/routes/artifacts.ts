import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Response } from 'express';
import { INDEX_FILE, ROOT_FOLDER_NAME } from '@aiapp/shared';
import { jobFolder, listFolderFiles, userRoot } from '../../artifacts/fileManager.js';
import { rebuildIndex } from '../../orchestrator/index-writer.js';
import { getJob, listJobs } from '../../repo/jobs.js';
import { badRequest, notFound } from '../../util/errors.js';
import { buildZip, type ZipEntry } from '../../util/zip.js';
import { asyncHandler, currentUser, requireAuth } from '../middleware.js';

export const artifactsRouter = Router();
artifactsRouter.use(requireAuth);

/** Lists the files in one link's folder (spec §11.1). */
artifactsRouter.get(
  '/:jobId/files',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const job = getJob(String(req.params['jobId']), user.userId);
    if (!job?.folderName) throw notFound('This link has no artifacts yet.');

    const files = await listFolderFiles(user.userId, job.folderName);
    res.json({ folderName: job.folderName, files });
  }),
);

/**
 * Streams a single artifact file.
 *
 * The requested path is resolved and then re-checked against the job folder, so
 * a `..` segment can never read outside the user's own tree.
 */
artifactsRouter.get(
  '/:jobId/file',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const job = getJob(String(req.params['jobId']), user.userId);
    if (!job?.folderName) throw notFound('This link has no artifacts yet.');

    const relative = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    if (!relative) throw badRequest('A file path is required.');

    const folder = jobFolder(user.userId, job.folderName);
    const resolved = path.resolve(folder, relative);
    if (!resolved.startsWith(folder + path.sep)) throw badRequest('That path is outside the link folder.');

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) throw notFound('No such file.');

    res.type(contentTypeFor(resolved));
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolved)}"`);
    res.send(await fs.readFile(resolved));
  }),
);

/** Downloads one link's folder as a ZIP. */
artifactsRouter.get(
  '/:jobId/export',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const job = getJob(String(req.params['jobId']), user.userId);
    if (!job?.folderName) throw notFound('This link has no artifacts yet.');

    const folder = jobFolder(user.userId, job.folderName);
    const files = await listFolderFiles(user.userId, job.folderName);
    const entries: ZipEntry[] = [];
    for (const file of files) {
      const full = path.join(folder, file);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      entries.push({
        path: path.posix.join(job.folderName, file),
        content: await fs.readFile(full),
        date: stat.mtime,
      });
    }

    sendZip(res, `${job.folderName}.zip`, entries);
  }),
);

/**
 * Downloads the entire "AI Enhancement App" folder as a ZIP — the offline
 * alternative to running the desktop bridge (spec §11, open question Q1).
 */
artifactsRouter.get(
  '/export/all',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await rebuildIndex(user.userId);

    const root = userRoot(user.userId);
    const entries: ZipEntry[] = [];

    const addFile = async (absolute: string, archivePath: string): Promise<void> => {
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile()) return;
      // Keep raw media out of the bundle; it is large and reproducible.
      if (archivePath.includes('/media/')) return;
      entries.push({ path: archivePath, content: await fs.readFile(absolute), date: stat.mtime });
    };

    await addFile(path.join(root, INDEX_FILE), path.posix.join(ROOT_FOLDER_NAME, INDEX_FILE));

    // Shared files the engine maintains alongside the per-link folders.
    for (const shared of ['_instructions.md', '_settings.md']) {
      await addFile(path.join(root, shared), path.posix.join(ROOT_FOLDER_NAME, shared));
    }
    const skillsDir = path.join(root, '_skills');
    for (const skill of await fs.readdir(skillsDir).catch(() => [] as string[])) {
      await addFile(path.join(skillsDir, skill), path.posix.join(ROOT_FOLDER_NAME, '_skills', skill));
    }

    for (const job of listJobs(user.userId, 5000)) {
      if (!job.folderName) continue;
      const folder = jobFolder(user.userId, job.folderName);
      for (const file of await listFolderFiles(user.userId, job.folderName)) {
        await addFile(path.join(folder, file), path.posix.join(ROOT_FOLDER_NAME, job.folderName, file));
      }
    }

    if (entries.length === 0) throw notFound('Nothing has been processed yet.');
    sendZip(res, 'AI-Enhancement-App.zip', entries);
  }),
);

function sendZip(res: Response, filename: string, entries: ZipEntry[]): void {
  const archive = buildZip(entries);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(archive.byteLength));
  res.send(archive);
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
