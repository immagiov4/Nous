"""Behavior checks for the public source boundary, ranking, and cache."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('screen', Path(__file__).with_name('screen.py'))
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)

class ScreenChecks(unittest.TestCase):
    def test_latest_decider_uses_filtered_catalog_and_daily_cache(self):
        catalog = [
            {'id':'perplexity/pplx-decider-v1.2','created':1},
            {'id':'perplexity/pplx-decider-v1.3:free','created':2},
            {'id':'perplexity/pplx-decider-flash-v2.0','created':3},
        ]
        with tempfile.TemporaryDirectory() as folder, patch.object(screen, 'decisions_catalog', create=True, return_value=catalog) as listing:
            home = Path(folder)
            self.assertEqual(screen.latest_decider(home), 'perplexity/pplx-decider-v1.3:free')
            self.assertEqual(screen.latest_decider(home), 'perplexity/pplx-decider-v1.3:free')
            self.assertEqual(listing.call_count, 1)

    def test_screen_consent_precedence_and_anonymous_public_default(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)/'project'
            home = Path(folder)/'home'
            for path in [root, home]:
                (path/'.geppetto').mkdir(parents=True)
            choice = root/'.geppetto/config.json'
            user = home/'.geppetto/config.json'
            with patch.object(screen, 'public_remote', create=True, return_value=True) as lookup:
                self.assertEqual(screen.share_source(root, home), (True, 'public'))
                user.write_text('{"screen":{"shareSource":true}}')
                self.assertEqual(screen.share_source(root, home), (True, 'user'))
                choice.write_text('{"screen":{"shareSource":false}}')
                self.assertEqual(screen.share_source(root, home), (False, 'project'))
                self.assertEqual(lookup.call_count, 1)

    def test_source_choice_controls_remote_less_repository(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            screen.git(root, 'init', '-q')
            (root/'save.py').write_text('save = True')
            screen.git(root, 'add', '.')
            screen.git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
            (root/'request.txt').write_text('save')
            args = SimpleNamespace(repo=str(root), ref='HEAD', request_file=str(root/'request.txt'), output=str(root/'out.json'), cache=str(root/'cache'), chunk_chars=24000, source_suffix=[], inventory_only=False, mode='chat', model='fixture', workers=1, retries=0)
            for choice in [None, False, True]:
                (root/'.geppetto').mkdir(exist_ok=True)
                (root/'.geppetto/config.json').write_text(json.dumps({} if choice is None else {'screen': {'shareSource': choice}}))
                response = {'model': 'fixture', 'choices': [{'message': {'content': '{"score": 1, "reason": "save"}'}}], 'usage': {'cost': 0}}
                with patch.dict(os.environ, {'OPENROUTER_API_KEY': 'fixture'}), patch.object(screen.Path, 'home', return_value=root/'isolated-home'), patch.object(screen, 'api', return_value=response) as api:
                    self.assertEqual(screen.run(args), 0)
                    result = json.loads((root/'out.json').read_text())
                    self.assertEqual(api.called, choice is True)
                    if choice is not True:
                        self.assertIn('screen.shareSource', result['reason'])
                        self.assertIn('--share-source yes', result['reason'])
                    else:
                        self.assertTrue(result['complete'])

    def test_registered_worktree_location_does_not_exclude_its_public_source_repository(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            source = base/'source'
            source.mkdir()
            screen.git(source, 'init', '-q')
            (source/'screened.py').write_text('screened = True\n')
            screen.git(source, 'add', '.')
            screen.git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
            worktree = base/'DevData'/'worktree'
            worktree.parent.mkdir()
            screen.git(source, 'worktree', 'add', '--detach', str(worktree), 'HEAD')
            request = base/'request.txt'
            request.write_text('Screen the committed source')
            args = SimpleNamespace(repo=str(worktree), mode='decisions', inventory_only=True, ref='HEAD',
                request_file=str(request), cache=str(base/'cache'), output=str(base/'result.json'), chunk_chars=24000,
                source_suffix=[])
            self.assertEqual(screen.run(args), 0)
            self.assertEqual(json.loads((base/'result.manifest.json').read_text())['files'][0]['path'], 'screened.py')

    def test_choice_command_preserves_other_configuration(self):
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'.geppetto/config.json'
            path.parent.mkdir()
            path.write_text('{"memory":{"choice":"none"}}')
            for choice in ['yes', 'no']:
                result = subprocess.run([sys.executable, str(Path(screen.__file__)), '--repo', folder, '--share-source', choice], capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.assertEqual(result.returncode, 0, result.stderr)
                config = json.loads(path.read_text())
                self.assertEqual(config['memory']['choice'], 'none')
                self.assertEqual(config['screen']['shareSource'], choice == 'yes')


    def test_decision_result_without_usage_cost_keeps_score_model_and_reports_unknown_billing(self):
        response = {'model': 'perplexity/pplx-decider-v1.3:free', 'usage': None, 'answers': {
            'relevant': {'type': 'noul', 'noul': .8},
            'reason': {'type': 'choice', 'choice': 'capability'}}}
        chunk = {'path': 'save.ts', 'line': 1, 'offset': 0, 'source': 'save()'}
        with tempfile.TemporaryDirectory() as folder, patch.object(screen, 'api', return_value=response):
            result = screen.score_chunk('decisions', response['model'], 'Save files', chunk, Path(folder))
            self.assertEqual(result['score'], .8)
            self.assertEqual(result['model'], response['model'])
            self.assertIsNone(result['charged_usd'])

    def test_free_model_reserves_provider_admission_before_transport(self):
        from io import BytesIO
        with patch.dict(os.environ, {'OPENROUTER_API_KEY': 'fixture'}), \
             patch.object(screen, 'reserve_free_request') as reserve, \
             patch.object(screen.urllib.request, 'urlopen', side_effect=[BytesIO(b'{}'), BytesIO(b'{}')]):
            screen.api('/fixture', {'model': 'model:free'}, retries=0)
            screen.api('/fixture', {'model': 'model:paid'}, retries=0)
            self.assertEqual(reserve.call_count, 1)

    def test_503_is_retried_but_other_http_errors_are_terminal(self):
        from io import BytesIO
        response = BytesIO(b'{"model":"fixture"}')
        unavailable = urllib.error.HTTPError('https://example.invalid', 503, 'unavailable', {}, None)
        with patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic'}), patch.object(screen.urllib.request, 'urlopen', side_effect=[unavailable, response]) as transport, patch.object(screen.time, 'sleep'):
            self.assertEqual(screen.api('/fixture', {}, retries=1)['model'], 'fixture')
            self.assertEqual(transport.call_count, 2)
        for status in [401, 429, 503]:
            error = urllib.error.HTTPError('https://example.invalid', status, 'failure', {}, None)
            with patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic'}), patch.object(screen.urllib.request, 'urlopen', side_effect=error) as transport, patch.object(screen.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, f'HTTP {status}'):
                    screen.api('/fixture', {}, retries=1)
                self.assertEqual(transport.call_count, 2 if status == 503 else 1)

    def test_retried_503_cost_gaps_survive_a_later_transport_failure(self):
        unavailable = urllib.error.HTTPError('https://example.invalid', 503, 'unavailable', {}, None)
        with patch.dict(os.environ, {'OPENROUTER_API_KEY': 'synthetic'}), patch.object(screen.urllib.request, 'urlopen', side_effect=[unavailable, urllib.error.URLError('synthetic')]), patch.object(screen.time, 'sleep'):
            with self.assertRaises(urllib.error.URLError) as raised:
                screen.api('/fixture', {}, retries=1)
            self.assertEqual(raised.exception.retry503s, 1)

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
            self.assertNotIn('UserPromptSubmit', result['hooks'])
            self.assertEqual((home/'skills'/'requirements-blast-radius'/'SKILL.md').read_text(), 'fixture')

if __name__ == '__main__': unittest.main()
