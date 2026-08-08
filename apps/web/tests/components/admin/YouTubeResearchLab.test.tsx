// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';

const runAdminYouTubeResearchLabMock = vi.hoisted(() => vi.fn());
const evaluateYouTubeResearchLabMock = vi.hoisted(() => vi.fn());
const planYouTubeSearchQueryMock = vi.hoisted(() => vi.fn());
const readSupabaseSessionMock = vi.hoisted(() => vi.fn());
const readSupabaseAccessRoleMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/admin/adminApi.ts', () => ({
  runAdminYouTubeResearchLab: runAdminYouTubeResearchLabMock,
}));

vi.mock('../../../services/openrouter/research.ts', () => ({
  evaluateYouTubeResearchLab: evaluateYouTubeResearchLabMock,
}));

vi.mock('../../../services/openrouter/youtubeSearchQuery.ts', () => ({
  planYouTubeSearchQuery: planYouTubeSearchQueryMock,
}));

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  readSupabaseAccessRole: readSupabaseAccessRoleMock,
  readSupabaseSession: readSupabaseSessionMock,
}));

const { default: YouTubeResearchLab } = await import(
  '../../../components/admin/YouTubeResearchLab.tsx'
);

const researchResult = {
  diagnostic: {
    budget: {
      contextWindowTokens: 128_000,
      nonYouTubePromptTokens: 8_000,
      perTranscriptMaxTokens: 25_600,
      remainingTokens: 52_700,
      reservedOutputTokens: 32_000,
      residualTokens: 88_000,
      transcriptBudgetTokens: 52_800,
      usedTokens: 100,
    },
    bundle: {
      context:
        'SOURCE Pixel art curves\nURL: https://www.youtube.com/watch?v=M7lc1UVf-VE\n[01:05-01:32] Draw the curve.',
      videoCandidates: [
        {
          segments: [{ startSeconds: 65, endSeconds: 93, text: 'Draw the curve.' }],
          title: 'Pixel art curves',
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        },
      ],
    },
    candidates: [
      {
        channelTitle: 'Pixel school',
        channelVerified: true,
        decision: 'context-included',
        durationSeconds: 600,
        id: 'M7lc1UVf-VE',
        kind: 'video',
        origins: ['search'],
        title: 'Pixel art curves',
        transcript: {
          characterCount: 48,
          kind: 'manual',
          language: 'en',
          segments: [{ startSeconds: 65, endSeconds: 93, text: 'Draw the curve.' }],
          segmentCount: 1,
        },
        transcriptAttempts: [
          {
            durationMs: 12,
            kind: 'manual',
            language: 'en',
            outcome: 'available',
          },
        ],
        transcriptLookupMs: 12,
        url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        viewCount: 120_000,
      },
    ],
    errors: [],
    limits: {
      discoveryVideos: 6,
      playlistResults: 2,
      transcriptConcurrency: 2,
    },
    operations: {
      discoveryRequests: 1,
      playlistPreviewsExpanded: 0,
      transcriptRequests: 1,
      transcriptLookups: 1,
    },
    preferredLanguages: ['en'],
    query: 'Bordi e curve Pixel art',
    timings: { discoveryMs: 10, playlistExpansionMs: 0, totalMs: 24, transcriptsMs: 14 },
  },
  productionVideoClipsEnabled: false,
} as const;

describe('YouTubeResearchLab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRenderingLocaleOverride('en');
    readSupabaseSessionMock.mockReturnValue({
      accessToken: 'admin-token',
    });
    readSupabaseAccessRoleMock.mockReturnValue('admin');
    runAdminYouTubeResearchLabMock.mockResolvedValue(researchResult);
    planYouTubeSearchQueryMock.mockResolvedValue({
      fallbackQuery: 'pixel art curves tutorial',
      focusConcept: 'pixel art curves',
      specificQuery: 'pixel art curves step by step tutorial',
    });
    evaluateYouTubeResearchLabMock.mockResolvedValue({
      dossier: {
        avoidOversimplifying: [],
        controversies: [],
        difficultSteps: [],
        factualSummary: 'Curves use stepped diagonals.',
        generatedAt: '2026-07-17T00:00:00.000Z',
        keyExamples: [],
        recentDevelopments: [],
        sectionId: 'youtube-research-lab',
        sources: [
          {
            title: 'Pixel art curves',
            url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
            note: 'Shows the curve on the canvas.',
            videoClip: { startSeconds: 65, endSeconds: 92 },
          },
        ],
        title: 'Bordi e curve',
      },
      model: {
        attempts: { research: 1, structuring: 1, total: 2 },
        timings: { researchMs: 100, structuringMs: 50, totalMs: 150 },
      },
      researchBrief: 'The first candidate is useful as a practical demonstration.',
      youtubeCandidateDecisions: [
        {
          decision: 'selected-source',
          reason: 'The timestamp shows the curve being drawn step by step.',
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        },
      ],
    });
  });

  afterEach(() => {
    setRenderingLocaleOverride(null);
  });

  test('runs the real query and renders the selected timestamped embed', async () => {
    const user = userEvent.setup();
    render(<YouTubeResearchLab />);

    await user.type(screen.getByLabelText('Course topic'), 'Pixel art');
    await user.type(screen.getByLabelText('Lesson title or objective'), 'Bordi e curve');
    await user.click(screen.getByRole('button', { name: 'Run the actual pipeline' }));

    await waitFor(() =>
      expect(runAdminYouTubeResearchLabMock).toHaveBeenCalledWith({
        contextWindowTokens: 128_000,
        language: 'Italiano',
        nonYouTubePromptTokens: 8_000,
        query: 'pixel art curves step by step tutorial',
        reservedOutputTokens: 32_000,
      })
    );
    expect(evaluateYouTubeResearchLabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lessonGoal: 'Bordi e curve',
        topic: 'Pixel art',
        youtubeResearch: expect.objectContaining({ videoClipsEnabled: true }),
      })
    );
    expect(await screen.findByText('Video preview')).toBeInTheDocument();
    expect(screen.getAllByTitle('Pixel art curves')).toHaveLength(1);
    expect(screen.getByTitle('Pixel art curves')).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=0&controls=1&end=93&enablejsapi=1&playsinline=1&rel=0&start=65'
    );
    expect(
      screen.getAllByText('The timestamp shows the curve being drawn step by step.')
    ).toHaveLength(2);
    expect(screen.getByText('Model attempts').parentElement).toHaveTextContent('2');
  });

  test('shows the structured rejection reason for a model-evaluated candidate', async () => {
    const user = userEvent.setup();
    evaluateYouTubeResearchLabMock.mockResolvedValueOnce({
      dossier: {
        avoidOversimplifying: [],
        controversies: [],
        difficultSteps: [],
        factualSummary: 'Curves use stepped diagonals.',
        generatedAt: '2026-07-17T00:00:00.000Z',
        keyExamples: [],
        recentDevelopments: [],
        sectionId: 'youtube-research-lab',
        sources: [],
        title: 'Pixel art',
      },
      model: {
        attempts: { research: 1, structuring: 1, total: 2 },
        timings: { researchMs: 100, structuringMs: 50, totalMs: 150 },
      },
      researchBrief: 'The candidate is too general.',
      youtubeCandidateDecisions: [
        {
          decision: 'rejected',
          reason: 'It explains tools broadly but never demonstrates the requested curve technique.',
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        },
      ],
    });
    render(<YouTubeResearchLab />);

    await user.type(screen.getByLabelText('Course topic'), 'Pixel art');
    await user.click(screen.getByRole('button', { name: 'Run the actual pipeline' }));

    expect(await screen.findAllByText('Rejected by the model')).toHaveLength(2);
    expect(
      screen.getAllByText(
        'It explains tools broadly but never demonstrates the requested curve technique.'
      )
    ).toHaveLength(2);
  });

  test('skips model evaluation when Decodo returns no transcript context', async () => {
    const user = userEvent.setup();
    runAdminYouTubeResearchLabMock.mockResolvedValueOnce({
      ...researchResult,
      diagnostic: {
        ...researchResult.diagnostic,
        bundle: { context: '', videoCandidates: [] },
        candidates: [
          {
            ...researchResult.diagnostic.candidates[0],
            decision: 'no-transcript',
            transcript: undefined,
            transcriptAttempts: [
              {
                durationMs: 20,
                kind: 'manual',
                language: 'en',
                outcome: 'unavailable',
              },
            ],
          },
        ],
      },
    });
    render(<YouTubeResearchLab />);

    await user.type(screen.getByLabelText('Course topic'), 'Pixel art');
    await user.click(screen.getByRole('button', { name: 'Run the actual pipeline' }));

    expect(
      await screen.findByText(
        'No transcript entered the context. Model evaluation was skipped to avoid two useless calls.'
      )
    ).toBeInTheDocument();
    expect(evaluateYouTubeResearchLabMock).not.toHaveBeenCalled();
  });

  test('localizes transcript kinds in Italian', async () => {
    const user = userEvent.setup();
    setRenderingLocaleOverride('it');
    render(<YouTubeResearchLab />);

    await user.type(screen.getByLabelText('Argomento del corso'), 'Pixel art');
    await user.click(screen.getByRole('button', { name: 'Esegui il percorso reale' }));

    expect(await screen.findAllByText(/manuale/)).not.toHaveLength(0);
  });

  test('never matches a playlist to a selected source with no video URL', async () => {
    const user = userEvent.setup();
    runAdminYouTubeResearchLabMock.mockResolvedValueOnce({
      ...researchResult,
      diagnostic: {
        ...researchResult.diagnostic,
        candidates: [
          ...researchResult.diagnostic.candidates,
          {
            channelTitle: 'Pixel school',
            channelVerified: false,
            decision: 'playlist-expanded',
            id: 'playlist-1',
            kind: 'playlist',
            origins: ['search'],
            title: 'Pixel art playlist',
            transcriptAttempts: [],
            url: 'https://www.youtube.com/playlist?list=playlist-1',
          },
        ],
      },
    });
    evaluateYouTubeResearchLabMock.mockResolvedValueOnce({
      dossier: {
        avoidOversimplifying: [],
        controversies: [],
        difficultSteps: [],
        factualSummary: 'Curves use stepped diagonals.',
        generatedAt: '2026-07-17T00:00:00.000Z',
        keyExamples: [],
        recentDevelopments: [],
        sectionId: 'youtube-research-lab',
        sources: [{ title: 'Source without URL' }],
        title: 'Pixel art',
      },
      model: {
        attempts: { research: 1, structuring: 1, total: 2 },
        timings: { researchMs: 100, structuringMs: 50, totalMs: 150 },
      },
      researchBrief: 'The playlist is not a video candidate.',
      youtubeCandidateDecisions: [],
    });
    render(<YouTubeResearchLab />);

    await user.type(screen.getByLabelText('Course topic'), 'Pixel art');
    await user.click(screen.getByRole('button', { name: 'Run the actual pipeline' }));

    const playlistCard = (await screen.findByText('Pixel art playlist')).closest('article');
    expect(playlistCard).not.toBeNull();
    expect(
      within(playlistCard as HTMLElement).getByText(/Not eligible as a clip/)
    ).toBeInTheDocument();
    expect(
      within(playlistCard as HTMLElement).queryByText('Selected as a source, without a clip')
    ).toBeNull();
  });

  test('keeps collected diagnostics visible when model evaluation fails', async () => {
    const user = userEvent.setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    evaluateYouTubeResearchLabMock.mockRejectedValueOnce(new Error('private provider failure'));
    render(<YouTubeResearchLab />);

    await user.type(screen.getByLabelText('Course topic'), 'Pixel art');
    await user.click(screen.getByRole('button', { name: 'Run the actual pipeline' }));

    expect(await screen.findAllByText('Pixel art curves')).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('YouTube lab is unavailable.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private provider failure');
    warn.mockRestore();
  });

  test('does not render admin diagnostics for an authenticated non-admin', () => {
    readSupabaseSessionMock.mockReturnValue({
      accessToken: 'user-token',
    });
    readSupabaseAccessRoleMock.mockReturnValue('user');

    const { container } = render(<YouTubeResearchLab />);

    expect(container).toBeEmptyDOMElement();
  });

  test('does not flash admin diagnostics without a session', () => {
    readSupabaseSessionMock.mockReturnValue(null);
    readSupabaseAccessRoleMock.mockReturnValue(null);

    const { container } = render(<YouTubeResearchLab />);

    expect(container).toBeEmptyDOMElement();
  });
});
