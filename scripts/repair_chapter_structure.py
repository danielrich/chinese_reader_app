#!/usr/bin/env python3
"""Preview or repair explicitly selected book shelves without resplitting texts."""

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def plan_book(conn, shelf_id, source_order=None):
    book = conn.execute('SELECT name FROM shelves WHERE id=?', (shelf_id,)).fetchone()
    if book is None:
        raise ValueError(f'Shelf {shelf_id} does not exist')
    chapters = []
    for sid, title, position in conn.execute(
        'SELECT id,name,sort_order FROM shelves WHERE parent_id=?', (shelf_id,)
    ):
        if conn.execute('SELECT 1 FROM shelves WHERE parent_id=?', (sid,)).fetchone():
            raise ValueError(f'Shelf {sid} contains nested shelves; select a book, not a collection')
        sections = list(conn.execute('SELECT title,sort_order FROM texts WHERE shelf_id=?', (sid,)))
        if not sections or any(
            name != title and not (
                name.startswith(title + ' section ') and name[len(title + ' section '):].isdigit()
            ) for name, _ in sections
        ):
            raise ValueError(f'Shelf {sid} is not a recognizable chapter shelf')
        orders = [order for _, order in sections]
        if None in orders or len(set(orders)) != len(orders):
            raise ValueError(f'Shelf {sid} has ambiguous section order')
        chapters.append(dict(kind='shelf', id=sid, title=title, position=position))
    for tid, title, position in conn.execute(
        'SELECT id,title,sort_order FROM texts WHERE shelf_id=?', (shelf_id,)
    ):
        chapters.append(dict(kind='text', id=tid, title=title, position=position))
    if not chapters:
        raise ValueError(f'Shelf {shelf_id} is empty')
    titles = [chapter['title'] for chapter in chapters]
    if len(set(titles)) != len(titles):
        raise ValueError(f'Shelf {shelf_id} has duplicate chapter titles; manual review required')
    if source_order is not None:
        if (not isinstance(source_order, list) or not all(isinstance(t, str) for t in source_order)
                or len(source_order) != len(titles) or set(source_order) != set(titles)):
            raise ValueError(f'Source order must name every chapter of shelf {shelf_id} exactly once')
        positions = {title: i for i, title in enumerate(source_order)}
        chapters.sort(key=lambda chapter: positions[chapter['title']])
    else:
        orders = [chapter['position'] for chapter in chapters]
        if None in orders or len(set(orders)) != len(orders):
            raise ValueError(f'Shelf {shelf_id} has ambiguous chapter order; supply --source-orders')
        chapters.sort(key=lambda chapter: chapter['position'])
    for i, chapter in enumerate(chapters):
        chapter['target_position'] = i
    return dict(id=shelf_id, title=book[0], chapters=chapters)


def repair_database(path, shelf_ids, apply=False, source_orders=None, backup_dir=None):
    path = Path(path).expanduser().resolve(strict=True)
    source_orders = source_orders or {}
    # mode=ro also makes a preview unable to accidentally create or change a DB.
    uri = path.as_uri() + ('?mode=rw' if apply else '?mode=ro')
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    backup_path = None
    try:
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        books = [plan_book(conn, sid, source_orders.get(sid)) for sid in dict.fromkeys(shelf_ids)]
        changes = any(c['kind'] == 'text' or c['position'] != c['target_position']
                      for book in books for c in book['chapters'])
        if apply and changes:
            destination = Path(backup_dir).expanduser() if backup_dir else path.parent / 'backups'
            destination.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            backup_path = destination / f'{path.name}.backup-{stamp}'
            # A separate reader sees the exact pre-repair snapshot while our
            # IMMEDIATE transaction prevents concurrent writers until commit.
            source = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
            try:
                target = sqlite3.connect(backup_path)
                try:
                    source.backup(target)
                    if target.execute('PRAGMA quick_check').fetchone() != ('ok',):
                        raise RuntimeError('Backup integrity check failed')
                finally:
                    target.close()
            finally:
                source.close()
            for book in books:
                for chapter in book['chapters']:
                    if chapter['kind'] == 'text':
                        cursor = conn.execute(
                            'INSERT INTO shelves(name,parent_id,sort_order) VALUES (?,?,?)',
                            (chapter['title'], book['id'], chapter['target_position']),
                        )
                        # Do not edit content, title, sort order, or timestamps.
                        conn.execute('UPDATE texts SET shelf_id=? WHERE id=?',
                                     (cursor.lastrowid, chapter['id']))
                    elif chapter['position'] != chapter['target_position']:
                        conn.execute('UPDATE shelves SET sort_order=? WHERE id=?',
                                     (chapter['target_position'], chapter['id']))
            if conn.execute("SELECT 1 FROM sqlite_master WHERE name='shelf_analyses_cache' AND type='table'").fetchone():
                conn.execute('DELETE FROM shelf_analyses_cache')
            if conn.execute('PRAGMA foreign_key_check').fetchone():
                raise RuntimeError('Foreign key check failed; repair rolled back')
        conn.commit()
        return dict(applied=apply, changes=changes, backup=str(backup_path) if backup_path else None, books=books)
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db-path', type=Path, required=True)
    parser.add_argument('--shelf-id', type=int, action='append', required=True,
                        help='Book shelf to repair (repeat for multiple books; not recursive)')
    parser.add_argument('--source-orders', type=Path,
                        help='JSON object mapping book shelf IDs to complete chapter title lists, verified against the source EPUB')
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--apply', action='store_true', help='Write the repair; default is read-only preview')
    args = parser.parse_args()
    try:
        orders = json.loads(args.source_orders.read_text()) if args.source_orders else {}
        if not isinstance(orders, dict):
            raise ValueError('Source orders must be a JSON object')
        result = repair_database(args.db_path, args.shelf_id, args.apply,
                                 {int(key): value for key, value in orders.items()}, args.backup_dir)
    except (ValueError, OSError, sqlite3.Error, RuntimeError) as exc:
        parser.exit(1, f'Repair stopped: {exc}\n')
    print('Applied' if args.apply else 'PREVIEW (no database changes)')
    for book in result['books']:
        print(f"\nBook {book['id']}: {book['title']}")
        for chapter in book['chapters']:
            action = 'create chapter shelf; move existing text' if chapter['kind'] == 'text' else 'keep chapter shelf'
            print(f"  {chapter['target_position'] + 1:3}. {chapter['title']} [{action}; {chapter['kind']} ID {chapter['id']}]")
    if result['backup']:
        print(f"\nBackup: {result['backup']}")
    if not result['changes']:
        print('\nAlready organized; no changes needed.')


if __name__ == '__main__':
    main()
