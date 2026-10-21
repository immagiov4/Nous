/** Local prompt-context hook. The model judges scope and message provenance. */
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit') process.exit(0);
if (typeof input.prompt !== 'string' || !input.prompt.trim()) process.exit(0);
// A declared project hook owns injection; its version wins over a global copy.
const client = process.argv[process.argv.indexOf('--client') + 1];
if (!['claude', 'codex'].includes(client)) throw new Error('Pass --client claude or codex');
let directory = path.resolve(input.cwd || process.cwd());
while (true) {
  const localHook = path.join(
    directory,
    '.agents/skills/requirements-blast-radius/scripts/prompt-hook.cjs'
  );
  const settings = path.join(
    directory,
    client === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'
  );
  if (fs.existsSync(localHook) && fs.existsSync(settings)) {
    const groups = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.UserPromptSubmit || [];
    const projectMarker = ` --client ${client} --requirements-project-hook`;
    const declared = groups.some(group =>
      group.hooks?.some(
        handler => handler.type === 'command' && handler.command?.endsWith(projectMarker)
      )
    );
    if (declared) {
      if (!process.argv.includes('--requirements-project-hook')) process.exit(0);
      break;
    }
  }
  if (fs.existsSync(path.join(directory, '.git'))) break;
  const parent = path.dirname(directory);
  if (parent === directory) break;
  directory = parent;
}
const instruction =
  'Before acting, judge this message against the agreed requirements. For a substantial new request or steering that changes the agreed outcome, run requirements-blast-radius and produce/update its Requirements map. Handle tiny edits and straightforward localized bug fixes directly. For an orchestrator brief already containing a Requirements map section, reuse that map and examine only uncovered changes. The model judges scope and provenance; this hook only injects this instruction.';
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: process.argv.includes('--requirements-project-hook')
        ? instruction +
          ' Use the repository skill at .agents/skills/requirements-blast-radius/SKILL.md, resolved from the Git root, and resolve its references from that directory.'
        : instruction,
    },
  })
);
