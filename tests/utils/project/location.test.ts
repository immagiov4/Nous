import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildProjectLocationHref, getProjectIdFromLocation } from '../../../utils/project/location.ts';

test('reads the current project id from the location search params', () => {
  assert.equal(getProjectIdFromLocation('?project=project-123'), 'project-123');
  assert.equal(getProjectIdFromLocation({ search: '?foo=bar&project=project-456' }), 'project-456');
});

test('returns null when the project param is missing or empty', () => {
  assert.equal(getProjectIdFromLocation('?foo=bar'), null);
  assert.equal(getProjectIdFromLocation('?project='), null);
  assert.equal(getProjectIdFromLocation('?project=   '), null);
});

test('builds a bookmarkable project url while preserving the rest of the location', () => {
  const href = buildProjectLocationHref(
    {
      pathname: '/reader',
      search: '?foo=bar',
      hash: '#lesson-2',
    },
    'project-789'
  );

  assert.equal(href, '/reader?foo=bar&project=project-789#lesson-2');
});

test('removes the project param without touching other search params or the hash', () => {
  const href = buildProjectLocationHref(
    {
      pathname: '/reader',
      search: '?foo=bar&project=project-789&view=compact',
      hash: '#lesson-2',
    },
    null
  );

  assert.equal(href, '/reader?foo=bar&view=compact#lesson-2');
});
