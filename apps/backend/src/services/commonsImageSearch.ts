import { isCommonsLink } from '@shared/lessonStudios/imageAnnotateSpec';
import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5';
import * as z from 'zod';

const COMMONS_CANDIDATE_LIMIT = 12;
export const COMMONS_USER_AGENT = 'NousReader/1.0 (https://github.com/immagiov4/Nous)';
const commons = 'commons.wikimedia.org';
const wikidata = 'www.wikidata.org';
const metadataFields =
  'Artist|Credit|Attribution|AttributionRequired|LicenseShortName|LicenseUrl|Restrictions|DeletionReason';
const imageInfo = {
  prop: 'imageinfo',
  iiprop: 'url|size|mime|thumbmime|extmetadata',
  iiurlwidth: '640',
  iiextmetadatafilter: metadataFields,
};
const filePage = z.object({
  title: z.string(),
  index: z.number().optional(),
  imagerepository: z.string().optional(),
  imageinfo: z
    .array(
      z.object({
        descriptionurl: z.string(),
        thumburl: z.string(),
        mime: z.string(),
        thumbmime: z.string().optional(),
        thumbwidth: z.number().int().positive(),
        thumbheight: z.number().int().positive(),
        extmetadata: z.record(z.string(), z.object({ value: z.string() }).optional()),
      })
    )
    .optional(),
});
function textParts(node: DefaultTreeAdapterTypes.Node): string {
  if ('value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(textParts).join(' ') : '';
}
const plainText = (value: string | undefined) =>
  textParts(parseFragment(value ?? ''))
    .replaceAll(/\s+/gu, ' ')
    .trim();

export function commonsRasterUrl(value: string): URL | undefined {
  const url = URL.parse(value);
  if (
    !url ||
    (url.origin !== 'https://upload.wikimedia.org' &&
      url.origin !== 'https://thumb.wikimedia.org') ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/wikipedia/commons/') ||
    !/\.(?:jpe?g|png|webp)$/iu.test(url.pathname)
  )
    return undefined;
  return url;
}

function licenseLink(name: string, value: string) {
  if (name === 'Public domain') return '';
  const url = URL.parse(value);
  if (
    !url ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.hostname !== 'creativecommons.org' ||
    url.username ||
    url.password ||
    url.port
  )
    return undefined;
  const cc = /^CC BY(-SA)? (\d\.\d)(?: ([A-Z]{2}))?$/u.exec(name);
  const path = cc ? attributionLicensePath(cc) : cc0LicensePath(name);
  if (!path || url.pathname.replace(/\/?$/u, '/') !== path) return undefined;
  return `https://creativecommons.org${path}`;
}

function attributionLicensePath([, shareAlike, version, country]: readonly string[]) {
  const family = shareAlike ? 'by-sa' : 'by';
  const jurisdiction = country ? `${country.toLowerCase()}/` : '';
  return `/licenses/${family}/${version}/${jurisdiction}`;
}

function cc0LicensePath(name: string) {
  return /^CC0(?: 1\.0)?$/u.test(name) ? '/publicdomain/zero/1.0/' : undefined;
}

type Lane = 'wikipedia' | 'wikidata' | 'categories' | 'keywords';
function candidate(value: unknown, lane: Lane) {
  const page = filePage.safeParse(value);
  if (!page.success) return undefined;
  const { title, imageinfo } = page.data;
  const info = imageinfo?.[0];
  if (
    !info ||
    !info.mime.startsWith('image/') ||
    (info.thumbmime && !/^image\/(?:jpeg|png|webp)$/u.test(info.thumbmime)) ||
    !commonsRasterUrl(info.thumburl) ||
    !isCommonsLink(info.descriptionurl)
  )
    return undefined;
  const meta = (key: string) => plainText(info.extmetadata[key]?.value);
  const author = meta('Artist');
  const credit = meta('Credit');
  const attribution = meta('Attribution');
  const license = meta('LicenseShortName');
  const licenseUrl = licenseLink(license, meta('LicenseUrl'));
  if (
    licenseUrl === undefined ||
    meta('Restrictions') ||
    meta('DeletionReason') ||
    ((license.startsWith('CC BY') || meta('AttributionRequired') === 'true') &&
      !(attribution || author))
  )
    return undefined;
  return {
    file: title,
    thumbnail: info.thumburl,
    origins: [lane],
    image: {
      title: title.replace(/^File:/u, ''),
      author,
      credit,
      attribution,
      license,
      licenseUrl,
      source: info.descriptionurl,
      width: info.thumbwidth,
      height: info.thumbheight,
    },
  };
}

export type CommonsImageCandidate = NonNullable<ReturnType<typeof candidate>>;
type CommonsConcept = { concept: { it: string; en: string }; queries?: readonly string[] };

const titled = z.object({ title: z.string() });
const page = z.object({
  pageimage: z.string().optional(),
  pageprops: z
    .object({ wikibase_item: z.string().optional(), commonscat: z.string().optional() })
    .optional(),
  images: z.array(titled).optional(),
  iwlinks: z.array(titled).optional(),
});
const queryResult = z.object({
  query: z
    .object({
      pages: z.array(z.unknown()).optional(),
      search: z.array(z.object({ pageid: z.number() })).optional(),
      categorymembers: z.array(titled).optional(),
    })
    .optional(),
});
const claim = z.object({
  rank: z.string().optional(),
  mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }),
});
const entityResult = z.object({
  search: z.array(z.object({ id: z.string() })).optional(),
  entities: z
    .record(
      z.string(),
      z.object({
        claims: z.record(z.string(), z.array(claim)).optional(),
        sitelinks: z.object({ commonswiki: titled.optional() }).optional(),
      })
    )
    .optional(),
});

function claimValues(claims: z.infer<typeof claim>[]) {
  return claims.flatMap(entry => {
    const value = entry.mainsnak.datavalue?.value;
    return entry.rank !== 'deprecated' && typeof value === 'string' ? [value] : [];
  });
}

function interleave<T>(groups: readonly (readonly T[])[]) {
  return Array.from({ length: Math.max(0, ...groups.map(group => group.length)) }, (_, index) =>
    groups.flatMap(group => (group[index] === undefined ? [] : [group[index]]))
  ).flat();
}

function mergeCandidates(rows: readonly CommonsImageCandidate[]) {
  const bySource = new Map<string, CommonsImageCandidate>();
  for (const row of rows) {
    const existing = bySource.get(row.image.source);
    if (existing) existing.origins = [...new Set([...existing.origins, ...row.origins])];
    else bySource.set(row.image.source, { ...row });
  }
  return [...bySource.values()].slice(0, COMMONS_CANDIDATE_LIMIT);
}

export function createCommonsImageSearch(options: {
  userAgent: string;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}) {
  const cached = new Map<string, Promise<CommonsImageCandidate[]>>();
  const fetcher = options.fetch ?? fetch;
  async function request(host: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`https://${host}/w/api.php`);
    url.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
    const response = await fetcher(url, {
      headers: { 'User-Agent': options.userAgent },
      redirect: 'error',
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Wikimedia HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) throw new Error('Wikimedia API error');
    return body;
  }

  const query = async (host: string, params: Record<string, string>) =>
    queryResult.parse(await request(host, { action: 'query', ...params })).query;

  async function files(host: string, titles: string[], lane: Lane) {
    const batch = [...new Set(titles)].slice(0, 50);
    if (!batch.length) return [];
    const result = await query(host, { titles: batch.join('|'), redirects: '1', ...imageInfo });
    const pages = (result?.pages ?? []).flatMap(row => {
      const parsed = filePage.safeParse(row);
      if (parsed.success && (host === commons || parsed.data.imagerepository === 'shared'))
        return [parsed.data];
      return [];
    });
    const rank = new Map(batch.map((title, index) => [title.replaceAll('_', ' '), index]));
    pages.sort((a, b) => (rank.get(a.title) ?? Infinity) - (rank.get(b.title) ?? Infinity));
    return rows(pages, lane);
  }

  async function article(lang: 'it' | 'en', term: string) {
    const host = `${lang}.wikipedia.org`;
    const result = await query(host, {
      list: 'search',
      srsearch: term,
      srnamespace: '0',
      srlimit: '1',
      srprop: '',
    });
    const hit = result?.search?.[0];
    if (!hit) return { files: [], qids: [], categories: [] };
    const detail = await query(host, {
      pageids: String(hit.pageid),
      prop: 'images|pageimages|pageprops|iwlinks',
      imlimit: 'max',
      piprop: 'name',
      ppprop: 'wikibase_item|commonscat',
      iwprefix: 'commons',
      iwlimit: 'max',
    });
    const found = page.parse(detail?.pages?.[0] ?? {});
    const lead = found.pageimage ? [`File:${found.pageimage}`] : [];
    return {
      files: await files(
        host,
        [...lead, ...(found.images ?? []).map(image => image.title)],
        'wikipedia'
      ),
      qids: found.pageprops?.wikibase_item ? [found.pageprops.wikibase_item] : [],
      categories: [
        found.pageprops?.commonscat,
        ...(found.iwlinks ?? [])
          .map(link => link.title)
          .filter(title => title.startsWith('Category:')),
      ].filter(Boolean),
    };
  }

  async function entities(ids: string[], label: string) {
    let qids = [...new Set(ids)].filter(id => /^Q\d+$/u.test(id));
    if (!qids.length) {
      const result = entityResult.parse(
        await request(wikidata, {
          action: 'wbsearchentities',
          search: label,
          language: 'en',
          type: 'item',
          limit: '1',
        })
      );
      qids = (result.search ?? []).map(hit => hit.id).filter(id => /^Q\d+$/u.test(id));
    }
    if (!qids.length) return { files: [], categories: [] };
    const result = entityResult.parse(
      await request(wikidata, {
        action: 'wbgetentities',
        ids: qids.join('|'),
        props: 'claims|sitelinks',
        sitefilter: 'commonswiki',
      })
    );
    const entries = qids.flatMap(id => (result.entities?.[id] ? [result.entities[id]] : []));
    return {
      files: await files(
        commons,
        entries.flatMap(entry => claimValues(entry.claims?.P18 ?? [])).map(name => `File:${name}`),
        'wikidata'
      ),
      categories: entries.flatMap(entry => {
        const title = entry.sitelinks?.commonswiki?.title;
        return [
          ...claimValues(entry.claims?.P373 ?? []),
          ...(title?.startsWith('Category:') ? [title] : []),
        ];
      }),
    };
  }

  async function members(title: string, kind: 'file' | 'subcat') {
    const result = await query(commons, {
      list: 'categorymembers',
      cmtitle: title,
      cmtype: kind,
      cmprop: 'title',
      cmlimit: '50',
    });
    return (result?.categorymembers ?? []).map(member => member.title);
  }

  async function categoryFiles(categories: string[]) {
    const roots = [
      ...new Set(
        categories.map(title => `Category:${title.replace(/^Category:/u, '').replaceAll('_', ' ')}`)
      ),
    ];
    const supporting: string[] = [];
    for (const root of roots) {
      const children = await members(root, 'subcat');
      supporting.push(
        ...children.filter(title => /\b(?:diagrams?|schem[ai]|diagramm[ai])\b/iu.test(title))
      );
    }
    const groups: CommonsImageCandidate[][] = [];
    for (const category of new Set([...supporting, ...roots])) {
      groups.push(await files(commons, await members(category, 'file'), 'categories'));
      if (mergeCandidates(interleave(groups)).length >= COMMONS_CANDIDATE_LIMIT) break;
    }
    return interleave(groups);
  }

  async function keywords(queries: readonly string[]) {
    const found: CommonsImageCandidate[] = [];
    for (const term of new Set(queries)) {
      const words = term.trim().split(/\s+/u).slice(0, 3).filter(Boolean);
      while (words.length) {
        const result = await query(commons, {
          generator: 'search',
          gsrnamespace: '6',
          gsrlimit: String(COMMONS_CANDIDATE_LIMIT),
          gsrsearch: `${words.join(' ')} filetype:bitmap|drawing`,
          ...imageInfo,
        });
        const pages = (result?.pages ?? []).flatMap(value => {
          const parsed = filePage.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
        pages.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
        const eligible = rows(pages, 'keywords');
        if (eligible.length) {
          found.push(...eligible);
          break;
        }
        words.pop();
      }
      if (mergeCandidates(found).length >= COMMONS_CANDIDATE_LIMIT) break;
    }
    return found;
  }

  async function collect({ concept, queries = [concept.it, concept.en] }: CommonsConcept) {
    const italian = await article('it', concept.it);
    const english = await article('en', concept.en);
    const wikidata = await entities([...italian.qids, ...english.qids], concept.en);
    const categories = await categoryFiles(
      [...italian.categories, ...english.categories, ...wikidata.categories].filter(
        (title): title is string => Boolean(title)
      )
    );
    const words = await keywords(queries);
    return mergeCandidates(
      interleave([interleave([italian.files, english.files]), wikidata.files, categories, words])
    );
  }

  function search(input: CommonsConcept) {
    const key = JSON.stringify([input.concept.it, input.concept.en, input.queries]);
    const existing = cached.get(key);
    if (existing) return existing;
    const pending = collect(input).catch(error => {
      cached.delete(key);
      throw error;
    });
    cached.set(key, pending);
    return pending;
  }
  return { search, prefetch: search };
}

function rows(pages: readonly unknown[], lane: Lane) {
  return pages.flatMap(page => {
    const row = candidate(page, lane);
    return row ? [row] : [];
  });
}
