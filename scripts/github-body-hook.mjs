import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertValidMarkdownBody } from './github-body.mjs';

const guidance =
  'Read .agents/skills/writing-for-humans/SKILL.md and .agents/skills/writing-for-humans/references/change-reports.md. Use a single gh command with a literal --body-file path (gh api: --field body=@path).';
const unreadable = () => {
  throw new Error(`Cannot read the GitHub body safely. ${guidance}`);
};

const quotedArgument = (command, start) => {
  const quote = command[start];
  let value = '';
  for (let index = start + 1; index < command.length; index += 1) {
    const char = command[index];
    if (char === quote) return { value, end: index };
    if (quote === '"' && /[$`]/u.test(char)) unreadable();
    if (char === '\\' && quote === '"' && /["\\$`]/u.test(command[index + 1] ?? ''))
      value += command[++index];
    else value += char;
  }
  unreadable();
};

// Read literal argv only; shell interpolation and compound publication require a body file.
const literalArguments = command => {
  if (/\r?\n\s*\S/u.test(command.replace(/"[^"]*"|'[^']*'/gu, ''))) unreadable();
  const tokens = [];
  let token = '';
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '"' || char === "'") {
      const quoted = quotedArgument(command, index);
      token += quoted.value;
      index = quoted.end;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else {
      if (/[;&|<>$`()%{}#]/u.test(char)) unreadable();
      token += char;
      started = true;
    }
  }
  if (started) tokens.push(token);
  return tokens;
};
const flagValues = (args, names) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.indexOf('=');
    const name = equals < 0 ? argument : argument.slice(0, equals);
    const compact = names.find(
      flag => flag.length === 2 && argument.startsWith(flag) && argument.length > 2
    );
    if (compact) {
      values.push(argument.slice(2));
      continue;
    }
    if (!names.includes(name)) continue;
    const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
    if (value === undefined) unreadable();
    values.push(value);
  }
  return values;
};
const fileBody = async (path, cwd) => {
  if (!path || path === '-' || /[$`%]/u.test(path)) unreadable();
  return readFile(resolve(cwd, path), 'utf8');
};

const stripRoutingFlags = (args, index) => {
  while (args[index]) {
    if (['--repo', '-R', '--hostname'].includes(args[index])) args.splice(index, 2);
    else if (/^--(?:repo|hostname)=|^-R.+/u.test(args[index])) args.splice(index, 1);
    else break;
  }
};

const checkPrArguments = async (args, cwd) => {
  stripRoutingFlags(args, 2);
  const action = args[2];
  if (!['create', 'edit'].includes(action)) return;
  const files = flagValues(args, ['--body-file', '-F']);
  const bodies = flagValues(args, ['--body', '-b']);
  if (
    action === 'edit' &&
    files.length + bodies.length === 0 &&
    args.some(arg => /^--(?:title|base|add-|remove-|milestone)/u.test(arg))
  )
    return;
  if (
    files.length + bodies.length !== 1 ||
    args.some(arg => /^(?:--(?:web|editor)(?:=|$)|-[df]*[ew])/u.test(arg))
  )
    unreadable();
  const body = files.length ? await fileBody(files[0], cwd) : bodies[0];
  assertValidMarkdownBody(body, 'GitHub body', 'pr');
};
const readApiBody = async (args, inputFile, bodyField, cwd) => {
  if (inputFile) {
    const payload = JSON.parse(await fileBody(inputFile, cwd));
    if (!Object.hasOwn(payload, 'body')) return;
    return payload.body;
  }
  {
    const field = bodyField.slice('body='.length);
    // --raw-field never expands @file; require --field for files.
    const raw = flagValues(args, ['--raw-field', '-f']).includes(bodyField);
    return field.startsWith('@') && !raw ? await fileBody(field.slice(1), cwd) : field;
  }
};
const checkApiBody = (body, creating) => {
  if (body === undefined) {
    if (creating) unreadable();
    return;
  }
  if (typeof body !== 'string') unreadable();
  assertValidMarkdownBody(body, 'GitHub body', 'pr');
};
const checkApiArguments = async (args, cwd) => {
  if (
    args.some(arg =>
      /^(?:https:\/\/api\.github\.com\/)?\/?repos\/[^/]+\/[^/]+\/issues(?:\/|$)/u.test(arg)
    )
  )
    return;
  const endpoint = args.find(arg =>
    /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls(?:\/\d+)?(?:\?.*)?$/u.test(arg)
  );
  if (!endpoint) {
    if (
      args.some(arg => /pulls|pullRequest|graphql/u.test(arg)) &&
      args.some(arg => /body|--input/u.test(arg))
    )
      unreadable();
    return;
  }
  const methods = flagValues(args, ['--method', '-X']);
  const fields = flagValues(args, ['--field', '-F', '--raw-field', '-f']);
  const inputs = flagValues(args, ['--input']);
  const method = (
    methods.at(-1) ?? (fields.length || inputs.length ? 'POST' : 'GET')
  ).toUpperCase();
  if (!['PATCH', 'POST'].includes(method)) return;
  const bodyFields = fields.filter(field => field.startsWith('body='));
  const creating = method === 'POST' && /\/pulls(?:\?|$)/u.test(endpoint);
  if (!bodyFields.length && !inputs.length) {
    if (creating) unreadable();
    return;
  }
  if (bodyFields.length + inputs.length !== 1) unreadable();
  const body = await readApiBody(args, inputs[0], bodyFields[0], cwd);
  checkApiBody(body, creating);
};

/** Validate publication without running the command or contacting GitHub. */
export const checkPublication = async (command, cwd = process.cwd()) => {
  const candidate = command.replace(/["']/gu, '');
  if (
    !/\bgh(?:\.exe)?["']?\s+[\s\S]*?\b(?:pr\b[\s\S]*?\b(?:create|edit)\b|api\b)/iu.test(candidate)
  )
    return;
  const prCommand = /\bpr\b[\s\S]*?\b(?:create|edit)\b/iu.test(candidate);
  if (!prCommand && !/pulls|pullRequest|graphql|\$|`/u.test(command)) return;
  const args = literalArguments(command);
  stripRoutingFlags(args, 1);
  if (!/^(?:.*[/\\])?gh(?:\.exe)?$/iu.test(args[0] ?? '')) unreadable();
  if (args[1] === 'pr') await checkPrArguments(args, cwd);
  else if (args[1] === 'api') await checkApiArguments(args, cwd);
  else if (args[1] !== 'issue') unreadable();
};

export const runHook = async event => {
  const input = event.tool_input ?? {};
  const command = input.command ?? input.cmd ?? input.command_line;
  if (typeof command !== 'string') return;
  await checkPublication(command, input.workdir ?? event.cwd ?? process.cwd());
};
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    await runHook(JSON.parse(input));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${guidance}\n`
    );
    process.exitCode = 2;
  }
}
