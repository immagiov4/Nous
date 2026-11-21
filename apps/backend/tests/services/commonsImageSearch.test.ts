import { describe, expect, test, vi } from 'vitest';
import { createCommonsImageSearch } from '../../src/services/commonsImageSearch';

const options = { userAgent: 'Nous test' };
const query = {
  concept: { it: 'Prospettiva', en: 'Perspective' },
  queries: ['tiling perspective lines', 'perspective photo'],
};
const source = 'https://commons.wikimedia.org/wiki/File:One_point_perspective.jpg';
const thumbnail =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Perspective.jpg/640px-Perspective.jpg';
const file = (name: string, metadata: Record<string, string> = {}, url = thumbnail) => ({
  pageid: 1,
  title: `File:${name}`,
  imageinfo: [
    {
      descriptionurl: source,
      thumburl: url,
      mime: 'image/jpeg',
      thumbwidth: 640,
      thumbheight: 460,
      width: 2234,
      height: 1604,
      extmetadata: Object.fromEntries(
        Object.entries({
          Artist: '<a href="/wiki/User:Author">Laitche</a> &amp; team',
          LicenseShortName: 'CC BY-SA 4.0',
          LicenseUrl: 'http://creativecommons.org/licenses/by-sa/4.0/',
          AttributionRequired: 'true',
          ...metadata,
        }).map(([name, value]) => [name, { value }])
      ),
    },
  ],
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
    expect(found).toMatchObject([
      {
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
      },
    ]);
  });

  test('filters disallowed rights, deletion flags, false licence links and unrelated hosts', async () => {
    const files = [
      file('Non commercial.jpg', { LicenseShortName: 'CC BY-NC 4.0' }),
      file('Pending deletion.jpg', { DeletionReason: 'Copyright violation' }),
      file('Restricted.jpg', { Restrictions: 'Trademark' }),
      file('Bad license link.jpg', {
        LicenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      }),
      file(
        'Untrusted host.jpg',
        {},
        'https://upload.wikimedia.org.example/wikipedia/commons/x.jpg'
      ),
      file('Port.jpg', {}, 'https://upload.wikimedia.org:8080/wikipedia/commons/x.jpg'),
      file('No credit.jpg', { Artist: '' }),
      file(
        'Approved.jpg',
        {
          LicenseShortName: 'Public domain',
          LicenseUrl: '',
          AttributionRequired: 'false',
        },
        thumbnail.replace('upload.wikimedia.org', 'thumb.wikimedia.org')
      ),
    ];
    const fetch = vi.fn(async (url: URL) =>
      Response.json(url.searchParams.has('gsrsearch') ? { query: { pages: files } } : { query: {} })
    );
    const found = await createCommonsImageSearch({ ...options, fetch }).search(query);
    expect(found.map(candidate => candidate.file)).toEqual(['File:Approved.jpg']);
  });

  test('interleaves both Wikipedia languages, Wikidata P18, diagrams and short keywords', async () => {
    const received: string[] = [];
    const page = (name: string) => ({
      ...file(name),
      imagerepository: 'shared',
      imageinfo: [
        {
          ...file(name).imageinfo[0],
          descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}`,
        },
      ],
    });
    const fetch = vi.fn(async (url: URL) => {
      const params = url.searchParams;
      const language = url.hostname.split('.')[0];
      if (params.get('list') === 'search') {
        received.push(language);
        return Response.json({ query: { search: [{ pageid: 1 }] } });
      }
      if (params.has('pageids')) {
        return Response.json({
          query: {
            pages: [
              {
                pageimage: `${language}.jpg`,
                pageprops: { wikibase_item: 'Q1', commonscat: 'Concept' },
              },
            ],
          },
        });
      }
      if (params.get('action') === 'wbgetentities') {
        received.push('wikidata');
        return Response.json({
          entities: {
            Q1: {
              claims: {
                P18: [{ mainsnak: { datavalue: { value: 'Entity.jpg' } } }],
              },
            },
          },
        });
      }
      if (params.get('cmtype') === 'subcat') {
        received.push('categories');
        return Response.json({
          query: { categorymembers: [{ title: 'Category:Concept diagrams' }] },
        });
      }
      if (params.get('cmtype') === 'file') {
        return Response.json({ query: { categorymembers: [{ title: 'File:Diagram.jpg' }] } });
      }
      const title = params.get('titles');
      if (title) {
        return Response.json({
          query: { pages: [page(title.replace(/^File:/u, ''))] },
        });
      }
      if (params.has('gsrsearch')) {
        received.push('keywords');
        return Response.json({ query: { pages: [page('Keyword.jpg'), page('Entity.jpg')] } });
      }
      throw new Error('Unexpected Wikimedia request');
    });
    const found = await createCommonsImageSearch({ ...options, fetch }).search({
      ...query,
      queries: ['perspective'],
    });
    expect(received).toEqual(['it', 'en', 'wikidata', 'categories', 'keywords']);
    expect(found.map(row => row.file)).toEqual([
      'File:it.jpg',
      'File:Entity.jpg',
      'File:Diagram.jpg',
      'File:Keyword.jpg',
      'File:en.jpg',
    ]);
    expect(found[1].origins).toEqual(['wikidata', 'keywords']);
  });

  test('an HTTP rejection is observable and may be retried with the same prefetch key', async () => {
    let reject = true;
    const fetch = vi.fn(async (url: URL) => {
      if (!url.searchParams.has('gsrsearch')) return Response.json({ query: {} });
      return reject
        ? new Response(null, { status: 429 })
        : Response.json({
            query: { pages: [file('One point perspective.jpg')] },
          });
    });
    const client = createCommonsImageSearch({ ...options, fetch });
    await expect(client.prefetch(query)).rejects.toThrow(/429/u);
    reject = false;
    expect(await client.search(query)).toHaveLength(1);
  });
});
