import sqlite3
import tempfile
import unittest
from pathlib import Path

from repair_chapter_structure import plan_book, repair_database


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'library.db'
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.executescript('''
        PRAGMA foreign_keys=ON;
        CREATE TABLE shelves(id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER REFERENCES shelves(id), sort_order INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE texts(id INTEGER PRIMARY KEY, shelf_id INTEGER REFERENCES shelves(id), title TEXT, content TEXT, sort_order INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE reading_sessions(id INTEGER PRIMARY KEY, text_id INTEGER REFERENCES texts(id) ON DELETE CASCADE, position INTEGER);
        CREATE TABLE text_analyses(text_id INTEGER PRIMARY KEY REFERENCES texts(id), data TEXT);
        INSERT INTO shelves VALUES (1,'Book',NULL,0,'original'), (2,'Long',1,0,'original');
        INSERT INTO texts VALUES (10,2,'Long section 1','first',0,'original'), (11,2,'Long section 2','second',1,'original'), (12,1,'Interlude','short',1,'original');
        INSERT INTO reading_sessions VALUES (1,12,15), (2,10,30);
        INSERT INTO text_analyses VALUES (12,'cached');
        ''')
        self.conn.commit()

    def test_preview_is_read_only(self):
        before = self.path.read_bytes()
        result = repair_database(self.path, [1])
        self.assertEqual(len(result['books'][0]['chapters']), 2)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(list(Path(self.tmp.name).glob('*.backup-*')), [])

    def test_apply_preserves_history_content_ids_and_is_idempotent(self):
        protected = list(self.conn.execute('SELECT id,title,content,updated_at FROM texts ORDER BY id'))
        sessions = list(self.conn.execute('SELECT * FROM reading_sessions'))
        analysis = list(self.conn.execute('SELECT * FROM text_analyses'))
        result = repair_database(self.path, [1], apply=True)
        self.assertTrue(Path(result['backup']).exists())
        backup = sqlite3.connect(result['backup'])
        self.addCleanup(backup.close)
        self.assertEqual(backup.execute('SELECT shelf_id FROM texts WHERE id=12').fetchone(), (1,))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM texts WHERE shelf_id=1').fetchone(), (0,))
        self.assertEqual(list(self.conn.execute('SELECT name,sort_order FROM shelves WHERE parent_id=1 ORDER BY sort_order')), [('Long',0), ('Interlude',1)])
        self.assertEqual(protected, list(self.conn.execute('SELECT id,title,content,updated_at FROM texts ORDER BY id')))
        self.assertEqual(sessions, list(self.conn.execute('SELECT * FROM reading_sessions')))
        self.assertEqual(analysis, list(self.conn.execute('SELECT * FROM text_analyses')))
        again = repair_database(self.path, [1], apply=True)
        self.assertIsNone(again['backup'])
        self.assertEqual(self.conn.execute('SELECT count(*) FROM shelves').fetchone(), (3,))

    def test_ambiguous_order_requires_source(self):
        self.conn.execute('UPDATE texts SET sort_order=0 WHERE id=12')
        self.conn.commit()
        with self.assertRaisesRegex(ValueError, 'order'):
            plan_book(self.conn, 1)
        result = repair_database(self.path, [1], apply=True, source_orders={1:['Interlude','Long']})
        self.assertIsNotNone(result['backup'])
        self.assertEqual(list(self.conn.execute('SELECT name FROM shelves WHERE parent_id=1 ORDER BY sort_order')), [('Interlude',), ('Long',)])

    def test_incomplete_source_order_rejected(self):
        with self.assertRaises(ValueError):
            plan_book(self.conn, 1, ['Long'])

    def test_nested_or_unrelated_child_rejected(self):
        self.conn.execute("UPDATE texts SET title='Unrelated' WHERE id=10")
        with self.assertRaises(ValueError):
            plan_book(self.conn, 1)
        self.conn.execute("UPDATE texts SET title='Long section 1' WHERE id=10")
        self.conn.execute("INSERT INTO shelves VALUES (3,'Nested',2,0,'original')")
        with self.assertRaises(ValueError):
            plan_book(self.conn, 1)

    def test_all_books_validated_before_writes(self):
        with self.assertRaises(ValueError):
            repair_database(self.path, [1,999], apply=True)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM shelves').fetchone(), (2,))
        self.assertEqual(self.conn.execute('SELECT shelf_id FROM texts WHERE id=12').fetchone(), (1,))

    def test_midway_failure_rolls_back(self):
        self.conn.executescript("CREATE TRIGGER fail_move BEFORE UPDATE OF shelf_id ON texts BEGIN SELECT RAISE(ABORT,'test failure'); END;")
        with self.assertRaises(sqlite3.IntegrityError):
            repair_database(self.path, [1], apply=True)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM shelves').fetchone(), (2,))

    def test_backup_failure_prevents_changes(self):
        blocked = self.path.parent / 'not-a-directory'
        blocked.write_text('file')
        with self.assertRaises(OSError):
            repair_database(self.path, [1], apply=True, backup_dir=blocked)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM shelves').fetchone(), (2,))
        self.assertEqual(self.conn.execute('SELECT shelf_id FROM texts WHERE id=12').fetchone(), (1,))

    def test_duplicate_section_positions_rejected(self):
        self.conn.execute('UPDATE texts SET sort_order=0 WHERE id=11')
        with self.assertRaisesRegex(ValueError, 'section order'):
            plan_book(self.conn, 1)

    def test_missing_database_not_created(self):
        missing = self.path.parent / 'missing.db'
        with self.assertRaises((FileNotFoundError, sqlite3.OperationalError)):
            repair_database(missing, [1])
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
