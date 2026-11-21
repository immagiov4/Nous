"""Install this skill and preserve unrelated client settings."""
import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile


def write_atomic(path, contents):
    """Replace a file through an exclusively created sibling, preserving link targets."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(contents)
        Path(temporary).replace(path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def remove_prompt_hook(path, backup):
    if not path.exists():
        return
    original = path.read_bytes()
    settings = json.loads(original)
    groups = settings.get('hooks', {}).get('UserPromptSubmit', [])
    for group in groups:
        group['hooks'] = [handler for handler in group.get('hooks', []) if not (
            handler.get('type') == 'command' and (
                'requirements-blast-radius/scripts/prompt-hook.cjs' in handler.get('command', '').replace('\\', '/')
                or handler.get('command', '').endswith(' --requirements-project-hook')))]
    if 'UserPromptSubmit' in settings.get('hooks', {}):
        settings['hooks']['UserPromptSubmit'] = [group for group in groups if group['hooks']]
    if settings != json.loads(original):
        backup.mkdir(parents=True, exist_ok=True)
        target = backup / (path.parent.name + '-' + path.name)
        if not target.exists():
            target.write_bytes(original)
        write_atomic(path, json.dumps(settings, indent=2) + '\n')


def install(source, home, client, backup):
    source = source.resolve()
    destination = home / 'skills' / source.name
    same_directory = destination.resolve() == source
    if destination.exists() and not same_directory:
        old = backup / (home.name + '-skill')
        if not old.exists():
            old.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(destination, old)
        expected = (home / 'skills').resolve() / source.name
        if destination.resolve() != expected:
            raise ValueError('Skill destination resolves outside its owned directory')
        shutil.rmtree(destination)
    if not same_directory:
        shutil.copytree(source, destination, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    remove_prompt_hook(home / ('settings.json' if client == 'claude' else 'hooks.json'), backup)
    for path in source.rglob('*'):
        if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
            if path.read_bytes() != (destination / path.relative_to(source)).read_bytes():
                raise ValueError('Installed skill differs from source')
    print(str(destination))


def install_project(source, project, backup):
    """Vendor the canonical skill and expose a Claude entry point."""
    source, project = source.resolve(), project.resolve()
    if not project.is_dir():
        raise ValueError('Project must be an existing repository directory.')
    destination = project / '.agents/skills' / source.name
    claude = project / '.claude/skills' / source.name
    for directory in [destination, claude]:
        if directory.resolve() != directory:
            raise ValueError('Project skill directory must stay at its owned repository path')
    if destination.resolve() != source:
        if destination.exists():
            old = backup / 'project-skill'
            if not old.exists():
                old.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(destination, old)
            shutil.rmtree(destination)
        shutil.copytree(source, destination, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    claude.mkdir(parents=True, exist_ok=True)
    entry = claude / 'SKILL.md'
    saved_entry = backup / 'claude-skill.md'
    if entry.exists() and not saved_entry.exists():
        saved_entry.parent.mkdir(parents=True, exist_ok=True)
        saved_entry.write_bytes(entry.read_bytes())
    frontmatter = (source / 'SKILL.md').read_text(encoding='utf-8').split('---', 2)[1]
    entry_text = ('---' + frontmatter + '---\n\nRead and follow [the repository skill](../../../.agents/skills/' + source.name + '/SKILL.md). Resolve its references from that canonical directory.\n')
    write_atomic(entry, entry_text)
    for client, settings in [('claude', '.claude/settings.json'), ('codex', '.codex/hooks.json')]:
        remove_prompt_hook(project / settings, backup / client)
    print(str(destination))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, help='Vendor into a repository instead of global client homes.')
    parser.add_argument('--claude-home', type=Path, default=Path.home()/'.claude')
    parser.add_argument('--codex-home', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home()/'.codex')))
    parser.add_argument('--backup-dir', type=Path, help='External backup directory; defaults to a fresh OS temporary directory.')
    args = parser.parse_args()
    args.backup_dir = args.backup_dir or Path(tempfile.mkdtemp(prefix='requirements-install-'))
    print('Backups: ' + str(args.backup_dir.resolve()))
    source = Path(__file__).resolve().parents[1]
    if args.project:
        install_project(source, args.project, args.backup_dir.resolve())
        return
    install(source, args.claude_home.resolve(), 'claude', args.backup_dir.resolve()/'claude')
    install(source, args.codex_home.resolve(), 'codex', args.backup_dir.resolve()/'codex')


if __name__ == '__main__':
    main()
