"""Behavior checks for the public source boundary, ranking, and cache."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('screen', Path(__file__).with_name('screen.py'))
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)

class ScreenChecks(unittest.TestCase):
    def test_inventory_covers_committed_source_only_and_every_character(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            def git(*args):
                return screen.git(repo, *args)
            git('init', '-q')
            for name, body in {'src/save.ts': 'abcd\nefgh\nij', 'tests/save.ts': 'test', 'src/save.test.ts': 'test', '.env.local': 'PRIVATE', 'src/ignored.ts': 'old'}.items():
                target = repo / name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(body.encode('utf-8'))
            git('add', 'src/save.ts', 'tests/save.ts', 'src/save.test.ts')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
            (repo/'src/save.ts').write_text('PRIVATE DIRTY CONTENT')
            files, chunks = screen.inventory(repo, 'HEAD', 4)
            self.assertEqual([item['path'] for item in files], ['src/save.ts'])
            self.assertEqual(''.join(chunk['source'] for chunk in chunks), 'abcd\nefgh\nij')
            self.assertEqual([chunk['line'] for chunk in chunks], [1, 1, 2])

    def test_production_source_inside_distribution_or_vendor_is_included(self):
        self.assertTrue(screen.is_source('vendor/parser.py'))
        self.assertTrue(screen.is_source('dist/server.js'))

    def test_cache_reuses_identical_request_and_invalidates_changed_source_or_request(self):
        response = {'model': 'test-version', 'answers': {'relevant': {'type': 'noul', 'noul': .8}, 'reason': {'type': 'choice', 'choice': 'lifecycle'}}, 'usage': {'cost': .01}}
        chunk = {'path': 'save.ts', 'line': 1, 'offset': 0, 'source': 'save()'}
        with tempfile.TemporaryDirectory() as folder, patch.object(screen, 'api', return_value=response) as api:
            first = screen.score_chunk('decisions', 'test-model', 'upload', chunk, Path(folder))
            second = screen.score_chunk('decisions', 'test-model', 'upload', chunk, Path(folder))
            third = screen.score_chunk('decisions', 'test-model', 'speech', chunk, Path(folder))
            fourth = screen.score_chunk('decisions', 'test-model', 'upload', {**chunk, 'source': 'saveSlow()'}, Path(folder))
            self.assertEqual(api.call_count, 3)
            self.assertEqual([row['charged_usd'] for row in [first, second, third, fourth]], [.01, 0, .01, .01])

    def test_reported_spend_survives_invalid_scoring_response(self):
        response = {'model': 'test', 'choices': [{'message': {'content': 'invalid JSON'}}], 'usage': {'cost': .02}}
        chunk = {'path': 'save.ts', 'line': 1, 'offset': 0, 'source': 'save()'}
        with tempfile.TemporaryDirectory() as folder, patch.object(screen, 'api', return_value=response):
            with self.assertRaises(screen.ScoringFailure) as raised:
                screen.score_chunk('chat', 'test-model', 'upload', chunk, Path(folder))
            self.assertEqual(raised.exception.charged_usd, .02)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_ranking_keeps_strongest_chunk_and_stable_ties(self):
        rows = [{'path': 'b.ts', 'score': .7}, {'path': 'a.ts', 'score': .9}, {'path': 'b.ts', 'score': .9}]
        self.assertEqual([(row['path'], row['score']) for row in screen.rank(rows)], [('a.ts', .9), ('b.ts', .9)])

    def test_invalid_scores_fail_explicitly(self):
        for invalid in [float('nan'), float('inf'), -1, 2, True, '0.8']:
            with self.assertRaises(ValueError): screen.check_score(invalid)

class InstallerChecks(unittest.TestCase):
    def test_install_from_linked_skills_directory_preserves_source(self):
        spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install.py'))
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root/'home'
            home.mkdir()
            store = root/'store'
            store.mkdir()
            try:
                os.symlink(store, home/'skills', target_is_directory=True)
            except OSError as error:
                self.skipTest('Directory symlink unavailable: ' + str(error))
            source = store/'requirements-blast-radius'
            (source/'scripts').mkdir(parents=True)
            (source/'SKILL.md').write_bytes(b'fixture')
            (source/'scripts'/'prompt-hook.cjs').write_bytes(b'fixture')
            installer.install(source, home, 'claude', root/'backup')
            self.assertEqual((source/'SKILL.md').read_bytes(), b'fixture')
            self.assertEqual((home/'skills'/'requirements-blast-radius'/'SKILL.md').read_bytes(), b'fixture')

    def test_install_preserves_settings_and_is_idempotent(self):
        spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install.py'))
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root/'home'
            home.mkdir()
            settings = {'model': 'keep', 'permissions': {'allow': ['keep']}, 'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'keep'}]}]}}
            (home/'settings.json').write_text(json.dumps(settings))
            source = root/'requirements-blast-radius'
            (source/'scripts').mkdir(parents=True)
            (source/'SKILL.md').write_text('fixture')
            (source/'scripts'/'prompt-hook.cjs').write_text('fixture')
            installer.install(source, home, 'claude', root/'backup')
            stale = home/'skills'/'requirements-blast-radius'/'obsolete.py'
            stale.write_text('obsolete')
            installer.install(source, home, 'claude', root/'backup2')
            self.assertFalse(stale.exists())
            installer.install(home/'skills'/'requirements-blast-radius', home, 'claude', root/'backup3')
            result = json.loads((home/'settings.json').read_text())
            self.assertEqual(result['model'], settings['model'])
            self.assertEqual(result['permissions'], settings['permissions'])
            self.assertEqual(result['hooks']['Stop'], settings['hooks']['Stop'])
            self.assertEqual(len(result['hooks']['UserPromptSubmit']), 1)
            self.assertEqual((home/'skills'/'requirements-blast-radius'/'SKILL.md').read_text(), 'fixture')

if __name__ == '__main__': unittest.main()
