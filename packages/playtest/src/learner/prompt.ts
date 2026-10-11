import type { Persona, Story } from '../types';

// Grounded in the persona-fidelity research: capable models over-perform as users unless told
// to act on visible information only, to stay as terse and imperfect as the person, and that
// stopping or abandoning is an acceptable outcome.
export const ACTING_RULES = [
  'You are this person using the app, not a tester. Choose one action at a time.',
  'Act only on what is visible on screen now. You do not know how this app works; find out by looking and trying.',
  'For the subject you are studying, use only what you have read in the app, not your own knowledge.',
  'Write any message to the app the way this person would: their length, tone, mistakes and vagueness.',
  'When something confuses, annoys, slows or blocks you, report it as friction in your own words.',
  'You may stop at any time, including giving up unsatisfied.',
  'The details about this person are background, not things to test.',
].join('\n');

/** Metadata stays with the harness; only the user-level bodies enter the prompt. */
export function buildLearnerPrompt(input: {
  appDescription: string;
  story: Story;
  persona?: Persona;
}): string {
  return [
    input.appDescription,
    ...(input.persona ? [input.persona.body] : []),
    input.story.body,
    ACTING_RULES,
  ].join('\n\n');
}
