// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import SurfaceErrorBoundary from '../../../components/shared/SurfaceErrorBoundary.tsx';

const BrokenSurface = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) throw new Error('internal rendering detail');
  return <div>Contenuto ripristinato</div>;
};

describe('SurfaceErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('contains a render failure without exposing its technical detail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <SurfaceErrorBoundary surface="visual">
        <BrokenSurface shouldThrow />
      </SurfaceErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Questo elemento visivo non è disponibile.'
    );
    expect(screen.queryByText('internal rendering detail')).not.toBeInTheDocument();
  });

  test('retries the surface when its reset key changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <SurfaceErrorBoundary resetKey="first" surface="reader">
        <BrokenSurface shouldThrow />
      </SurfaceErrorBoundary>
    );

    rerender(
      <SurfaceErrorBoundary resetKey="second" surface="reader">
        <BrokenSurface shouldThrow={false} />
      </SurfaceErrorBoundary>
    );

    expect(screen.getByText('Contenuto ripristinato')).toBeInTheDocument();
  });
});
