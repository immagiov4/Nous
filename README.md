<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/d985924c-2339-4e80-834f-9b7ea2500aa4

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Code Map

If you are changing the app and do not know where to start, this is the fastest map:

- `App.tsx`: top-level screen shell. It decides whether we are in library, assessment, planning, or reading mode.
- `hooks/useWorkspaceController.ts`: public entry point for app workflows. The actual logic is split under `hooks/workspace-controller/`.
- `hooks/workspace-controller/assessmentPlanning.ts`: assessment chat flow and plan generation.
- `hooks/workspace-controller/projectLifecycle.ts`: open/import/delete projects and source attachment.
- `hooks/workspace-controller/sectionProgression.ts`: lesson loading, regeneration, deep dives, contextual Q&A, completion.
- `hooks/useProjectLibrary.ts`: project repository + autosave only.
- `hooks/useUiPreferencesPersistence.ts`: local UI preferences such as theme, voice, teleprompter speed, playback rate.
- `hooks/useWorkspaceReaderRuntime.ts`: reader-side runtime wiring for chrome, context menu, quiz UI, music, and TTS player.
- `components/WorkspaceReaderShell.tsx` and `components/workspace-reader-shell/`: reading UI composition and presentational pieces.
- `services/workspace-controller/`: pure helpers for snapshot hydration, learn-mode planning, and PDF asset merging.
- `services/geminiService.ts` and `services/gemini/`: AI-facing integrations and prompt orchestration.
- `backend/src/`: backend source of truth. `backend/dist/` is build output, not where you should edit code.
