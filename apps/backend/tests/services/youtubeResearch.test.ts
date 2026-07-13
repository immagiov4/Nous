import { describe, expect, test } from 'vitest';
import {
  buildYouTubeResearchContext,
  type CommandRunner,
  type YouTubeCandidate,
  type YouTubeDiscoveryProvider,
  type YouTubeTranscriptProvider,
  YoutubeTranscriptCliProvider,
  YtDlpDiscoveryProvider,
} from '../../src/services/youtubeResearch.js';

describe('YouTube research', () => {
  test('ranks title relevance ahead of unrelated popularity', async () => {
    const runner: CommandRunner = {
      run: async (_command, args) => {
        if (args.at(-1)?.startsWith('ytsearch')) {
          return JSON.stringify({
            entries: [
              {
                channel: 'Popular channel',
                duration: 4_000,
                id: 'unrelated',
                title: 'Una celebrità racconta la propria vita',
                url: 'https://www.youtube.com/watch?v=unrelated',
                view_count: 50_000_000,
              },
              {
                channel: 'Film school',
                duration: 1_500,
                id: 'cinema',
                title: 'Storia del cinema mondiale',
                url: 'https://www.youtube.com/watch?v=cinema',
                view_count: 10_000,
              },
            ],
          });
        }
        return JSON.stringify({ entries: [] });
      },
    };

    const candidates = await new YtDlpDiscoveryProvider(runner).search(
      'storia del cinema mondiale'
    );

    expect(candidates.map(candidate => candidate.id)).toEqual(['cinema', 'unrelated']);
  });

  test('combines deduplicated videos and playlist entries with timestamped transcripts', async () => {
    const video: YouTubeCandidate = {
      channelTitle: 'University',
      channelVerified: true,
      id: 'video-1',
      kind: 'video',
      title: 'Course lecture',
      url: 'https://www.youtube.com/watch?v=video-1',
    };
    const playlist: YouTubeCandidate = {
      channelTitle: 'University',
      channelVerified: true,
      id: 'playlist-1',
      kind: 'playlist',
      title: 'Complete course',
      url: 'https://www.youtube.com/playlist?list=playlist-1',
    };
    const discovery: YouTubeDiscoveryProvider = {
      expandPlaylist: async () => [
        { ...video, playlistId: playlist.id, playlistPosition: 1 },
        {
          ...video,
          id: 'video-2',
          playlistId: playlist.id,
          playlistPosition: 2,
          title: 'Second lecture',
          url: 'https://www.youtube.com/watch?v=video-2',
        },
      ],
      search: async () => [video, playlist],
    };
    const requestedIds: string[] = [];
    const transcripts: YouTubeTranscriptProvider = {
      getTranscript: async videoId => {
        requestedIds.push(videoId);
        return {
          kind: 'automatic',
          language: 'it',
          segments: [{ durationSeconds: 4, startSeconds: 65, text: 'Concetto verificabile' }],
        };
      },
    };

    const context = await buildYouTubeResearchContext(
      'argomento',
      'Italiano',
      discovery,
      transcripts
    );

    expect(requestedIds).toEqual(['video-1', 'video-2']);
    expect(context).toContain('[01:05] Concetto verificabile');
    expect(context).toContain('playlist playlist-1, posizione 2');
  });

  test('prefers an automatic course-language transcript over a manual fallback language', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: async (_command, args) => {
        calls.push(args);
        if (args.includes('it') && args.includes('--exclude-manually-created')) {
          return JSON.stringify([[{ duration: 2, start: 0, text: 'Trascrizione italiana' }]]);
        }
        throw new Error('Transcript unavailable');
      },
    };

    const transcript = await new YoutubeTranscriptCliProvider(runner).getTranscript('video-1', [
      'it',
      'en',
    ]);

    expect(transcript?.kind).toBe('automatic');
    expect(transcript?.language).toBe('it');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--exclude-generated');
    expect(calls[1]).toContain('--exclude-manually-created');
  });
});
