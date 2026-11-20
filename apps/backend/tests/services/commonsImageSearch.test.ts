import { describe, expect, test, vi } from 'vitest';
import { createCommonsImageSearch } from '../../src/services/commonsImageSearch';

const options = { userAgent: 'Nous test' };
const query = {
  concept: { it: 'Prospettiva', en: 'Perspective' },
  queries: ['tiling perspective lines', 'perspective photo'],
};
const source = 'https://commons.wikimedia.org/wiki/File:One_point_perspective.jpg';
const thumbnail = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Perspective.jpg/640px-Perspective.jpg';
const file = (name: string, metadata: Record<string, string> = {}, url = thumbnail) => ({
  pageid: 1,
  title: `File:${name}`,
  imageinfo: [{
    descriptionurl: source,
    thumburl: url,
    mime: 'image/jpeg',
    thumbwidth: 640,
    thumbheight: 460,
    width: 2234,
    height: 1604,
    extmetadata: Object.fromEntries(Object.entries({
      Artist: '<a href="/wiki/User:Author">Laitche</a> &amp; team',
      LicenseShortName: 'CC BY-SA 4.0',
      LicenseUrl: 'http://creativecommons.org/licenses/by-sa/4.0/',
      AttributionRequired: 'true',
      ...metadata,
    }).map(([name, value]) => [name, { value }])),
  }],
});

describe('Commons image retrieval', () => {
  test('prefetch and selection share requests and preserve rights and thumbnail geometry', async () => {
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      if (url.hostname !== 'commons.wikimedia.org') return Response.json({ query: {} });
      const search = url.searchParams.get('gsrsearch') ?? '';
      const pages = search.startsWith('tiling perspective filetype:')
        ? [file('One point perspective.jpg')]
        : [];
      return Response.json({ query: { pages } });
    });
    const client = createCommonsImageSearch({ ...options, fetch });
    const pending = client.prefetch(query);
    const found = await client.search(query);
    await pending;
    const coldCount = fetch.mock.calls.length;
    expect(coldCount).toBeGreaterThan(1);
    expect(await client.search(query)).toEqual(found);
    expect(fetch).toHaveBeenCalledTimes(coldCount);
    expect(found).toMatchObject([{
      file: 'File:One point perspective.jpg',
      thumbnail,
      origins: expect.arrayContaining(['keywords']),
      image: {
        author: 'Laitche & team',
        width: 640,
        height: 460,
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        source,
      },
    }]);
  });

  test('filters disallowed rights, deletion flags, false licence links and unrelated hosts', async () => {
    const files = [
      file('Non commercial.jpg', { LicenseShortName: 'CC BY-NC 4.0' }),
      file('Pending deletion.jpg', { DeletionReason: 'Copyright violation' }),
      file('Restricted.jpg', { Restrictions: 'Trademark' }),
      file('Bad license link.jpg', { LicenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/' }),
      file('Untrusted host.jpg', {}, 'https://upload.wikimedia.org.example/wikipedia/commons/x.jpg'),
      file('Port.jpg', {}, 'https://upload.wikimedia.org:8080/wikipedia/commons/x.jpg'),
      file('No credit.jpg', { Artist: '' }),
      file('Approved.jpg', { LicenseShortName: 'Public domain', LicenseUrl: '', AttributionRequired: 'false' }),
    ];
    const fetch = vi.fn(async (url: URL) => Response.json(url.searchParams.has('gsrsearch')
      ? { query: { pages: files } }
      : { query: {} }));
    const found = await createCommonsImageSearch({ ...options, fetch }).search(query);
    expect(found.map(candidate => candidate.file)).toEqual(['File:Approved.jpg']);
  });

  test('an HTTP rejection is observable and may be retried with the same prefetch key', async () => {
    let reject = true;
    const fetch = vi.fn(async (url: URL) => {
      if (!url.searchParams.has('gsrsearch')) return Response.json({ query: {} });
      return reject ? new Response(null, { status: 429 }) : Response.json({
        query: { pages: [file('One point perspective.jpg')] },
      });
    });
    const client = createCommonsImageSearch({ ...options, fetch });
    await expect(client.prefetch(query)).rejects.toThrow(/429/u);
    reject = false;
    expect(await client.search(query)).toHaveLength(1);
  });
});
