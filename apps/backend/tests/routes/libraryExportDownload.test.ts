import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { unavailableLibraryExportApi } from '../../src/projects/libraryExport.js';
import type { LibraryExportDownload } from '../../src/projects/libraryExportDelivery.js';
import { createLibraryExportDownloadRouter } from '../../src/routes/libraryExports.js';

const route = '/library-exports/3207883a-862a-447f-b9ed-6148effeb8ea/download';
let server: Server;
let url: string;
let archiveDirectory: string;
const archiveContent = Buffer.from('complete archive bytes');
let responseClosed: ReturnType<typeof Promise.withResolvers<void>>;
const getDownload = vi.fn<() => Promise<LibraryExportDownload | null>>();
const finish = vi.fn<(delivered: boolean) => Promise<void>>();
const download = (): LibraryExportDownload => ({
  archiveBytes: 14,
  archivePath: join(tmpdir(), 'missing-library-export-test', 'archive.zip'),
  filename: 'archive.zip',
  userId: 'owner',
  finish,
});

beforeEach(async () => {
  archiveDirectory = await mkdtemp(join(tmpdir(), 'library-export-download-'));
  await writeFile(join(archiveDirectory, 'archive.zip'), archiveContent);
  getDownload.mockReset();
  finish.mockReset().mockResolvedValue();
  responseClosed = Promise.withResolvers<void>();
  const app = express();
  app.use((_req, res, next) => {
    res.once('close', () => responseClosed.resolve());
    next();
  });
  app.use(createLibraryExportDownloadRouter({ ...unavailableLibraryExportApi, getDownload }));
  server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a local HTTP test address.');
  url = `http://127.0.0.1:${address.port}${route}`;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  vi.restoreAllMocks();
  await rm(archiveDirectory, { recursive: true, force: true });
});

test.each([
  'bytes=0-3',
  'bytes=999-1000',
])('delivers the complete archive despite a Range header of %s', async range => {
  getDownload.mockResolvedValue({
    ...download(),
    archiveBytes: archiveContent.length,
    archivePath: join(archiveDirectory, 'archive.zip'),
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { Range: range },
    body: new URLSearchParams({ downloadToken: 'synthetic-token' }),
  });
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(archiveContent);
  expect(response.headers.get('content-length')).toBe(String(archiveContent.length));
  expect(response.headers.has('content-range')).toBe(false);
  expect(response.headers.has('accept-ranges')).toBe(false);
  expect(finish).toHaveBeenCalledWith(true);
  expect(finish).not.toHaveBeenCalledWith(false);
});

test('releases a reader when the client disconnects while download admission is pending', async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<LibraryExportDownload | null>();
  getDownload.mockImplementation(() => {
    entered.resolve();
    return released.promise;
  });
  const body = 'downloadToken=synthetic-token';
  const client = httpRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  // Destroying the request deliberately resets the socket before response headers exist.
  client.on('error', () => undefined);
  client.end(body);
  await entered.promise;
  client.destroy();
  await responseClosed.promise;
  released.resolve(download());
  await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(false));
  expect(finish).not.toHaveBeenCalledWith(true);
});

test('releases a reader when Express fails to open the download file', async () => {
  getDownload.mockResolvedValue(download());
  const response = await request(server)
    .post(route)
    .type('form')
    .send({ downloadToken: 'synthetic-token' });
  expect(response.status).toBe(500);
  expect(finish.mock.calls[0]).toEqual([false]);
});

test('releases a reader if starting the transfer throws synchronously', async () => {
  getDownload.mockResolvedValue(download());
  vi.spyOn(express.response, 'download').mockImplementation(() => {
    throw new Error('Transfer setup failed.');
  });
  const response = await request(server)
    .post(route)
    .type('form')
    .send({ downloadToken: 'synthetic-token' });
  expect(response.status).toBe(500);
  expect(finish.mock.calls[0]).toEqual([false]);
});
