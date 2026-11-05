/** Rota pública que entrega as mídias das publicações (a Meta baixa daqui). Suporta Range para vídeo. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { CONTENT_TYPE_BY_EXT, mediaPath } from '../../posts/media.js';

export async function mediaRoutes(app: FastifyInstance) {
  app.get('/media/:ws/:file', async (req, reply) => {
    const { ws, file } = req.params as { ws: string; file: string };
    const path = mediaPath(ws, file);
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info?.isFile()) return reply.code(404).send({ error: 'not_found' });

    const type = CONTENT_TYPE_BY_EXT[file.split('.').pop()!] ?? 'application/octet-stream';
    reply
      .header('Content-Type', type)
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff');

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, info.size - 1);
      if (start > end) return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${info.size}`)
        .header('Content-Length', end - start + 1)
        .send(createReadStream(path, { start, end }));
    }
    return reply.header('Content-Length', info.size).send(createReadStream(path));
  });
}
