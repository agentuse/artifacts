import { afterEach, expect, it, vi } from 'vitest';
import { shareEntry } from '../viewer/src/api';

afterEach(() => vi.unstubAllGlobals());

it('explains the stale backend HTML response instead of reporting a JSON parse error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })));
  await expect(shareEntry('art_test')).rejects.toThrow('server is out of date');
});

it('does not claim a link exists when the backend returns unrelated JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok' })));
  await expect(shareEntry('art_test')).rejects.toThrow('invalid link');
});

it('returns a valid share and preserves actionable backend errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'shr_test', url: 'https://share.example.com/s/test' })));
  await expect(shareEntry('art_test')).resolves.toEqual({ id: 'shr_test', url: 'https://share.example.com/s/test' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Sharing is not configured.', { status: 503 })));
  await expect(shareEntry('art_test')).rejects.toThrow('Sharing is not configured.');
});
