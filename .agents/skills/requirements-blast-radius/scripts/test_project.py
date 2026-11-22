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

class ProjectChecks(unittest.TestCase):
    def test_install_updates_skills_and_preserves_settings_without_injecting_context(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'.git').mkdir()
            for name in ['.claude/settings.json', '.codex/hooks.json']:
                target = root/name; target.parent.mkdir(parents=True)
                target.write_text(json.dumps({'model':'keep','hooks':{'UserPromptSubmit':[{'hooks':[
                    {'type':'command','command':'keep'},
                    {'type':'command','command':'bun "C:/fixture/skills/requirements-blast-radius/scripts/prompt-hook.cjs" --client claude'},
                    {'type':'command','command':'bun -e "fixture" -- --client codex --requirements-project-hook'}
                ]}],'Stop':[]}}))
            installer.install_project(HERE.parent,root,root/'backups')
            installer.install_project(HERE.parent,root,root/'backups')
            self.assertEqual((root/'.agents/skills/requirements-blast-radius/SKILL.md').read_bytes(),(HERE.parent/'SKILL.md').read_bytes())
            self.assertTrue((root/'.claude/skills/requirements-blast-radius/SKILL.md').is_file())
            for name in ['.claude/settings.json', '.codex/hooks.json']:
                settings = json.loads((root/name).read_text())
                self.assertEqual(settings['model'],'keep')
                self.assertEqual(settings['hooks']['Stop'],[])
                self.assertEqual(settings['hooks']['UserPromptSubmit'],[{'hooks':[{'type':'command','command':'keep'}]}])
            for client in ['claude','codex']:
                home = root/client; home.mkdir()
                settings = home/('settings.json' if client=='claude' else 'hooks.json')
                settings.write_text(json.dumps({'hooks':{'UserPromptSubmit':[{'hooks':[{'type':'command','command':'keep'}]}]}}))
                installer.install(HERE.parent,home,client,root/('backup-'+client))
                self.assertEqual(json.loads(settings.read_text())['hooks']['UserPromptSubmit'],[{'hooks':[{'type':'command','command':'keep'}]}])
                self.assertFalse((home/'skills/requirements-blast-radius/scripts/prompt-hook.cjs').exists())

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
            settings.unlink(missing_ok=True)
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
            self.assertFalse((root/'.codex/hooks.json').exists())

    def test_provider_screen_without_key_skips_without_network(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        spec=importlib.util.spec_from_file_location('screen',HERE/'screen.py')
        screen=importlib.util.module_from_spec(spec); spec.loader.exec_module(screen)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'request.txt').write_text('Implement feature')
            (root/'.geppetto').mkdir(); (root/'.geppetto/config.json').write_text('{"screen":{"shareSource":true}}')
            args=SimpleNamespace(repo=str(root),ref='HEAD',request_file=str(root/'request.txt'),output=str(root/'out.json'),cache=str(root/'cache'),chunk_chars=10,source_suffix=[],inventory_only=False,mode='decisions',model='fixture')
            with patch.dict('os.environ',{},clear=True), patch.object(screen,'git',return_value='fixture'), patch.object(screen,'inventory',return_value=([],[])), patch.object(screen,'api') as api:
                self.assertEqual(screen.run(args),0)
                self.assertFalse(api.called)
            result=json.loads((root/'out.json').read_text())
            self.assertTrue(result['skipped']); self.assertFalse(result['complete'])

if __name__=='__main__': unittest.main()
