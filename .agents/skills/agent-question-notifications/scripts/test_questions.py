import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from questions import Store, acquire_lock


class NotesTests(unittest.TestCase):
    def test_concurrent_deduplication_and_persistent_dismissal(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            note = dict(id='review-12-question-1', source='Codex', context='PR 12', question='Come procedere?')
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: store.submit(note), range(12)))
            self.assertEqual(store.pending(), [note])
            store.dismiss(note['id'])
            reopened = Store(directory)
            reopened.submit(note)
            self.assertEqual(reopened.pending(), [])

    def test_conflicting_id_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            note = dict(id='one', source='Codex', context='Prova', question='Prima domanda?')
            store.submit(note)
            with self.assertRaises(ValueError):
                store.submit({**note, 'question': 'Altra domanda?'})
            self.assertEqual(store.pending(), [note])

    def test_one_window_and_lock_release(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            first = acquire_lock(store.directory)
            self.assertIsNotNone(first)
            try:
                self.assertIsNone(acquire_lock(store.directory))
            finally:
                first.close()
            second = acquire_lock(store.directory)
            self.assertIsNotNone(second)
            second.close()


if __name__ == '__main__':
    unittest.main()
