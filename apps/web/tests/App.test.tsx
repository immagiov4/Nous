// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../components/auth/AuthGate.tsx', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../components/admin/AdminPanel.tsx', () => ({
  default: () => <div>Admin panel</div>,
}));
vi.mock('../components/admin/YouTubeResearchLab.tsx', () => ({
  default: () => <div>YouTube research lab</div>,
}));
vi.mock('../app/AppContent.tsx', () => ({
  default: () => <div>Application content</div>,
}));

const { default: App } = await import('../App.tsx');

describe('App routing', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  test.each(['/admin', '/admin/'])('renders the admin panel at %s', async pathname => {
    window.history.replaceState({}, '', pathname);

    render(<App />);

    expect(await screen.findByText('Admin panel')).toBeInTheDocument();
    expect(screen.queryByText('Application content')).not.toBeInTheDocument();
  });

  test.each([
    '/admin/youtube-lab',
    '/admin/youtube-lab/',
  ])('renders the YouTube lab at %s', async pathname => {
    window.history.replaceState({}, '', pathname);

    render(<App />);

    expect(await screen.findByText('YouTube research lab')).toBeInTheDocument();
    expect(screen.queryByText('Application content')).not.toBeInTheDocument();
  });
});
