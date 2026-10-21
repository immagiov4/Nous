"""Check project installation and global/project hook coexistence."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('installer', HERE/'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

def invoke(script, cwd, client, project=False):
    result = subprocess.run(['bun', str(script), '--client', client] + (['--requirements-project-hook'] if project else []), input=json.dumps({'prompt':'Implement feature', 'cwd':str(cwd)}), text=True, capture_output=True, check=True, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    return json.loads(result.stdout) if result.stdout else None

class ProjectChecks(unittest.TestCase):
    def test_install_update_and_combined_hooks(self):
        with tempfile.TemporaryDirectory(prefix='requirements project ') as folder:
            root=Path(folder); repo=root/'repo'; repo.mkdir(); (repo/'.git').mkdir()
            original={'model':'keep','hooks':{'UserPromptSubmit':[{'hooks':[{'type':'command','command':'keep'}]}], 'Stop':[]}}
            for name in ['.claude/settings.json','.codex/hooks.json']:
                target=repo/name; target.parent.mkdir(); target.write_text(json.dumps(original))
            installer.install_project(HERE.parent,repo,root/'backups')
            dest=repo/'.agents/skills/requirements-blast-radius'
            (dest/'obsolete').write_text('stale')
            installer.install_project(HERE.parent,repo,root/'backups')
            self.assertFalse((dest/'obsolete').exists())
            self.assertEqual((dest/'SKILL.md').read_bytes(),(HERE.parent/'SKILL.md').read_bytes())
            self.assertTrue((repo/'.claude/skills/requirements-blast-radius/SKILL.md').is_file())
            self.assertFalse((repo/'.claude/settings.local.json').exists())
            nested=repo/'src'; nested.mkdir()
            for client,name in [('claude','.claude/settings.json'),('codex','.codex/hooks.json')]:
                settings=json.loads((repo/name).read_text()); groups=settings['hooks']['UserPromptSubmit']
                self.assertEqual(settings['model'],'keep'); self.assertEqual(settings['hooks']['Stop'],[])
                self.assertEqual(groups[0],original['hooks']['UserPromptSubmit'][0]); self.assertEqual(len(groups),2)
                command=groups[1]['hooks'][0]['command']; self.assertNotIn(str(repo),command)
                result=subprocess.run(command,shell=True,cwd=nested,input=json.dumps({'prompt':'Implement','cwd':str(repo)}),text=True,capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                self.assertEqual(result.returncode,0,result.stderr); self.assertTrue(json.loads(result.stdout)['hookSpecificOutput']['additionalContext'])
                home=root/client; installer.install(HERE.parent,home,client,root/('backup-'+client))
                global_hook=home/'skills/requirements-blast-radius/scripts/prompt-hook.cjs'
                local=dest/'scripts/prompt-hook.cjs'
                self.assertEqual([invoke(global_hook,nested,client),bool(invoke(local,nested,client,project=True))],[None,True])
                self.assertTrue(invoke(global_hook,root,client))
                (repo/name).unlink()
                self.assertTrue(invoke(global_hook,nested,client))

    def test_shared_global_and_project_file_emits_once_and_repo_version_wins(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'.git').mkdir()
            entry=root/'.claude/skills/requirements-blast-radius/SKILL.md'
            entry.parent.mkdir(parents=True); entry.write_text('Original entry')
            installer.install_project(HERE.parent,root,root/'backups')
            self.assertEqual((root/'backups/claude-skill.md').read_text(),'Original entry')
            local=root/'.agents/skills/requirements-blast-radius/scripts/prompt-hook.cjs'
            for client in ['claude','codex']:
                # Invocation identity remains distinct even when both commands share a file.
                self.assertIsNone(invoke(local,root,client))
                self.assertTrue(invoke(local,root,client,project=True))
            local.write_text("process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'repository version'}}))")
            for client in ['claude','codex']:
                self.assertIsNone(invoke(HERE/'prompt-hook.cjs',root,client))
                self.assertEqual(invoke(local,root,client,project=True)['hookSpecificOutput']['additionalContext'],'repository version')

    def test_claude_entry_file_link_preserves_canonical_content(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'.git').mkdir()
            installer.install_project(HERE.parent,root,root/'backups')
            entry=root/'.claude/skills/requirements-blast-radius/SKILL.md'
            canonical=root/'.agents/skills/requirements-blast-radius/SKILL.md'
            entry.unlink()
            try:
                os.symlink(canonical,entry)
            except OSError as error:
                self.skipTest('File symlink unavailable: '+str(error))
            installer.install_project(HERE.parent,root,root/'backups')
            self.assertEqual(canonical.read_bytes(),(HERE.parent/'SKILL.md').read_bytes())

    def test_project_directory_link_cannot_overwrite_external_skill(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); repo=root/'repo'; repo.mkdir()
            external=root/'external'; external.mkdir(); (external/'SKILL.md').write_text('External original')
            entry=repo/'.claude/skills/requirements-blast-radius'; entry.parent.mkdir(parents=True)
            try:
                os.symlink(external,entry,target_is_directory=True)
            except OSError as error:
                self.skipTest('Directory symlink unavailable: '+str(error))
            with self.assertRaises(ValueError):
                installer.install_project(HERE.parent,repo,root/'backups')
            self.assertEqual((external/'SKILL.md').read_text(),'External original')

    def test_stale_temporary_links_preserve_skill_and_settings_targets(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'.git').mkdir()
            installer.install_project(HERE.parent,root,root/'backups')
            canonical=root/'.agents/skills/requirements-blast-radius/SKILL.md'
            entry=root/'.claude/skills/requirements-blast-radius/SKILL.md'
            settings=root/'.claude/settings.json'
            original=root/'original.json'; original.write_text('{"preserve":true}')
            settings.unlink()
            try:
                os.symlink(canonical,entry.with_name('SKILL.md.requirements-tmp'))
                os.symlink(original,settings.with_suffix('.json.requirements-tmp'))
            except OSError as error:
                self.skipTest('File symlink unavailable: '+str(error))
            installer.install_project(HERE.parent,root,root/'backups')
            self.assertEqual(canonical.read_bytes(),(HERE.parent/'SKILL.md').read_bytes())
            self.assertEqual(json.loads(original.read_text()),{'preserve':True})

    def test_project_cli_accepts_only_project_option(self):
        import sys
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'.git').mkdir()
            result=subprocess.run([sys.executable,str(HERE/'install.py'),'--project',str(root)],text=True,capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertTrue((root/'.codex/hooks.json').is_file())

    def test_legacy_global_hook_is_updated_without_duplicate(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); home=root/'claude'; home.mkdir()
            command='bun "'+(home/'skills/requirements-blast-radius/scripts/prompt-hook.cjs').as_posix()+'"'
            (home/'settings.json').write_text(json.dumps({'hooks':{'UserPromptSubmit':[{'hooks':[{'type':'command','command':command}]}]}}))
            installer.install(HERE.parent,home,'claude',root/'backups')
            installer.install(HERE.parent,home,'claude',root/'backups')
            groups=json.loads((home/'settings.json').read_text())['hooks']['UserPromptSubmit']
            self.assertEqual(len(groups),1)
            self.assertTrue(invoke(home/'skills/requirements-blast-radius/scripts/prompt-hook.cjs',root,'claude'))

    def test_provider_screen_without_key_skips_without_network(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        spec=importlib.util.spec_from_file_location('screen',HERE/'screen.py')
        screen=importlib.util.module_from_spec(spec); spec.loader.exec_module(screen)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'request.txt').write_text('Implement feature')
            args=SimpleNamespace(repo=str(root),ref='HEAD',request_file=str(root/'request.txt'),output=str(root/'out.json'),cache=str(root/'cache'),public_code=True,chunk_chars=10,source_suffix=[],inventory_only=False,mode='decisions',model='fixture')
            with patch.dict('os.environ',{},clear=True), patch.object(screen,'git',return_value='fixture'), patch.object(screen,'inventory',return_value=([],[])), patch.object(screen,'api') as api:
                self.assertEqual(screen.run(args),0)
                self.assertFalse(api.called)
            result=json.loads((root/'out.json').read_text())
            self.assertTrue(result['skipped']); self.assertFalse(result['complete'])

if __name__=='__main__': unittest.main()
