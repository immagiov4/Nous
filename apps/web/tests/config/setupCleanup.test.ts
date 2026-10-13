// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { expect, test } from 'vitest';

let unmountCount = 0;
const CleanupProbe = () => {
  useEffect(
    () => () => {
      unmountCount += 1;
    },
    []
  );
  return createElement('p', null, 'Cleanup probe');
};

test('renders a component for the shared setup to clean up', () => {
  render(createElement(CleanupProbe));
  expect(document.body.textContent).toBe('Cleanup probe');
  expect(unmountCount).toBe(0);
});

test('the shared setup unmounts React trees and removes their containers between tests', () => {
  expect(document.body.childElementCount).toBe(0);
  expect(unmountCount).toBe(1);
});
