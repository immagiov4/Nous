"""Post-it locali per gli agenti: Python e Tk, senza dipendenze esterne."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager

STATE = Path(os.environ.get('AGENT_QUESTIONS_HOME', str(Path.home() / '.agent-questions')))
POLL_MS = 700
BG, CARD, TEXT, MUTED, ACCENT = '#f7f7f8', '#ffffff', '#29292e', '#71717a', '#8054c7'
WIDTH, HEIGHT, MARGIN = 480, 550, 24
CORNER_RADIUS = 16


def rounded_surface(canvas, width, height, radius, color):
    """Disegna una superficie con archi circolari e raggio esplicito."""
    canvas.delete('surface')
    diameter = radius * 2
    for x, y, start in ((0, 0, 90), (width - diameter, 0, 0),
                        (0, height - diameter, 180), (width - diameter, height - diameter, 270)):
        canvas.create_arc(x, y, x + diameter, y + diameter, start=start, extent=90,
                          fill=color, outline=color, tags='surface')
    canvas.create_rectangle(radius, 0, width - radius, height, fill=color, outline=color, tags='surface')
    canvas.create_rectangle(0, radius, width, height - radius, fill=color, outline=color, tags='surface')
    canvas.tag_lower('surface')


class Store:
    def __init__(self, directory=STATE):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'notes.sqlite3'
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created REAL NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def submit(self, note):
        fields = ('id', 'source', 'context', 'question')
        if not isinstance(note, dict) or any(not isinstance(note.get(key), str) or not note[key].strip() for key in fields):
            raise ValueError('Servono id, source, context e question non vuoti.')
        payload = json.dumps({key: note[key] for key in fields}, ensure_ascii=False, sort_keys=True)
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO notes (id, payload, created) VALUES (?, ?, ?)', (note['id'], payload, time.time()))
            if db.execute('SELECT payload FROM notes WHERE id = ?', (note['id'],)).fetchone()[0] != payload:
                raise ValueError('ID già usato per un altro contenuto. Assegna un nuovo ID.')

    def pending(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT payload FROM notes WHERE dismissed = 0 ORDER BY created, id')]

    def dismiss(self, note_id):
        with self.connect() as db:
            db.execute('UPDATE notes SET dismissed = 1 WHERE id = ?', (note_id,))


def acquire_lock(directory):
    """Il sistema operativo rilascia il blocco anche dopo un arresto inatteso."""
    lock = open(directory / 'window.lock', 'a+b')
    lock.seek(0, 2)
    if not lock.tell():
        lock.write(b'0')
        lock.flush()
    lock.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        return None
    return lock


def gui(store):
    if os.name == 'nt':
        import ctypes
        # Va impostato prima di creare Tk: evita l'ingrandimento bitmap di Windows.
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    import tkinter as tk
    from tkinter import ttk
    lock = acquire_lock(store.directory)
    if lock is None:
        return
    root = tk.Tk()
    scale = root.winfo_fpixels('1i') / 96
    radius = round(CORNER_RADIUS * scale)
    width, height = round(WIDTH * scale), round(HEIGHT * scale)
    root.title('Codex · Domande da leggere')
    root.configure(bg=BG)
    root.attributes('-topmost', True)
    root.minsize(340, 260)
    x = max(0, root.winfo_screenwidth() - width - MARGIN)
    y = max(0, root.winfo_screenheight() - height - MARGIN * 3)
    root.geometry(f'{width}x{height}+{x}+{y}')
    font = 'Segoe UI' if os.name == 'nt' else 'DejaVu Sans'
    root.option_add('*Font', (font, 10))
    tk.Label(root, text='Un agente ti sta cercando', font=(font, 15, 'bold'), bg=BG, fg=TEXT).pack(anchor='w', padx=20, pady=(18, 5))
    counter = tk.Label(root, bg=BG, fg=MUTED)
    counter.pack(anchor='w', padx=20, pady=(0, 14))
    scrollbar = ttk.Scrollbar(root, orient='vertical')
    scrollbar.pack(side='right', fill='y')
    canvas = tk.Canvas(root, bg=BG, highlightthickness=0, yscrollcommand=scrollbar.set)
    canvas.pack(fill='both', expand=True)
    scrollbar.configure(command=canvas.yview)
    stack = tk.Frame(canvas, bg=BG)
    stack_id = canvas.create_window((0, 0), window=stack, anchor='nw')
    stack.bind('<Configure>', lambda event: canvas.configure(scrollregion=canvas.bbox('all')))
    cards, labels = {}, []

    def resize(event):
        canvas.itemconfigure(stack_id, width=event.width)
        for label in labels:
            label.configure(wraplength=max(180, event.width - 72))

    canvas.bind('<Configure>', resize)

    def scroll(event):
        canvas.yview_scroll(-1 if event.num == 4 or event.delta > 0 else 1, 'units')

    for event in ('<MouseWheel>', '<Button-4>', '<Button-5>'):
        root.bind_all(event, scroll)

    def dismiss(note_id):
        try:
            store.dismiss(note_id)
        except sqlite3.Error:
            counter.configure(text='Chiusura non salvata. Riprova.')
        else:
            refresh()

    def add_card(note):
        card = tk.Canvas(stack, bg=BG, highlightthickness=0)
        card.pack(fill='x', padx=16, pady=(0, 12))
        inner = tk.Frame(card, bg=CARD)
        content_id = card.create_window((radius, radius), window=inner, anchor='nw')

        def layout_card(event=None):
            card_width = card.winfo_width()
            card.itemconfigure(content_id, width=max(1, card_width - radius * 2))
            card_height = inner.winfo_reqheight() + radius * 2
            if int(card.cget('height')) != card_height:
                card.configure(height=card_height)
            rounded_surface(card, card_width, card_height, radius, CARD)

        card.bind('<Configure>', layout_card)
        inner.bind('<Configure>', layout_card)
        for content, color, weight in ((note['source'], ACCENT, 'bold'), (note['context'], MUTED, 'normal'), (note['question'], TEXT, 'bold')):
            label = tk.Label(inner, text=content, bg=CARD, fg=color, justify='left', anchor='w',
                             wraplength=max(180, canvas.winfo_width() - 72), font=(font, 10, weight))
            label.pack(fill='x', pady=(0, 12))
            labels.append(label)
        label = tk.Label(inner, text='Rispondi nella conversazione originale.', bg=CARD, fg=MUTED, anchor='w', justify='left')
        label.pack(fill='x', pady=(0, 10))
        labels.append(label)
        button_width, button_height = round(108 * scale), round(42 * scale)
        button = tk.Canvas(inner, width=button_width, height=button_height, bg=CARD,
                           highlightthickness=0, takefocus=True, cursor='hand2')
        button.pack(anchor='e')
        rounded_surface(button, button_width, button_height, radius, TEXT)
        button.create_text(button_width / 2, button_height / 2, text='Ho letto', fill=CARD, font=(font, 10))
        for event in ('<ButtonRelease-1>', '<Return>', '<space>'):
            button.bind(event, lambda event: dismiss(note['id']))
        for event in ('<Enter>', '<FocusIn>'):
            button.bind(event, lambda event: rounded_surface(button, button_width, button_height, radius, ACCENT))
        for event in ('<Leave>', '<FocusOut>'):
            button.bind(event, lambda event: rounded_surface(button, button_width, button_height, radius, TEXT))
        cards[note['id']] = card

    def refresh():
        pending = store.pending()
        current_ids = {note['id'] for note in pending}
        for note_id in list(cards):
            if note_id not in current_ids:
                cards.pop(note_id).destroy()
        labels[:] = [label for label in labels if label.winfo_exists()]
        for note in pending:
            if note['id'] not in cards:
                add_card(note)
                root.deiconify()
        counter.configure(text=f'{len(pending)} da leggere · Sempre in primo piano')
        if not pending:
            root.withdraw()

    def tick():
        try:
            refresh()
        except sqlite3.Error:
            counter.configure(text='Archivio occupato. Nuovo tentativo in corso.')
        root.after(POLL_MS, tick)

    tick()
    try:
        root.mainloop()
    finally:
        lock.close()


def launch(store):
    executable = Path(sys.executable)
    if os.name == 'nt' and executable.with_name('pythonw.exe').exists():
        executable = executable.with_name('pythonw.exe')
    with open(store.directory / 'window.log', 'a', encoding='utf-8') as log:
        subprocess.Popen([str(executable), str(Path(__file__).resolve()), 'gui'], stdout=log, stderr=log,
                         stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                         start_new_session=os.name != 'nt')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('notify').add_argument('file', type=Path)
    for name in ('pending', 'gui', 'demo'):
        commands.add_parser(name)
    args = parser.parse_args()
    store = Store()
    try:
        if args.command == 'gui':
            gui(store)
            return
        if args.command == 'notify':
            store.submit(json.loads(args.file.read_text(encoding='utf-8-sig')))
            launch(store)
        elif args.command == 'demo':
            for note_id, context, question in (
                ('demo-lettura', 'Conversazione: Test comunicazione tra thread · Prova senza operazioni reali', 'Riesci a leggere questo post-it mentre lavori? Premi «Ho letto» per chiuderlo.'),
                ('demo-review', 'Revisione di una PR · Esempio dimostrativo', 'È arrivata una domanda sulla revisione. Preferisci mantenere il comportamento attuale o discuterne nella conversazione? È solo una prova: non ci sono PR in attesa.'),
            ):
                store.submit(dict(id=note_id, source='Codex · Domanda di prova', context=context, question=question))
            launch(store)
        print(json.dumps(store.pending(), ensure_ascii=True))
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(f'Errore: {exc}', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
