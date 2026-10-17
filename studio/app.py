"""Native desktop UI; runs the heavy pipeline in a resumable child process."""
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

ROOT = Path(__file__).resolve().parents[1]


class Studio:
    def __init__(self, window):
        self.window = window
        window.title('AI Dub Studio')
        window.geometry('950x690')
        window.minsize(740, 520)
        self.process = None
        self.last_error = None
        self.events = queue.Queue()
        self.source = tk.StringVar()
        self.project = tk.StringVar()
        self.preview = tk.BooleanVar(value=True)
        self.status = tk.StringVar(value='Import a Japanese video to begin. Models must be installed first.')
        self.busy_widgets = []
        frame = ttk.Frame(window, padding=18)
        frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='AI Dub Studio', font=('Segoe UI', 24, 'bold')).pack(anchor='w')
        ttk.Label(frame, text='Japanese → English • Local processing • Consistent speaker references').pack(anchor='w', pady=(0, 14))
        for label, variable, callback in [('Video', self.source, self.import_video), ('Project', self.project, self.open_project)]:
            row = ttk.Frame(frame)
            row.pack(fill='x', pady=4)
            ttk.Label(row, text=label, width=9).pack(side='left')
            entry = ttk.Entry(row, textvariable=variable)
            entry.pack(side='left', fill='x', expand=True)
            button = ttk.Button(row, text='Browse…', command=callback)
            button.pack(side='left', padx=(6, 0))
            self.busy_widgets.extend([entry, button])
        check = ttk.Checkbutton(frame, text='30-second preview (separate resumable project)', variable=self.preview)
        check.pack(anchor='w', pady=8)
        self.busy_widgets.append(check)
        row = ttk.Frame(frame)
        row.pack(fill='x', pady=4)
        for label, callback in [('1. Analyze speakers', lambda: self.start(True)), ('2. Render / Resume', lambda: self.start(False)),
                                ('Review / edit script', self.edit), ('Play result', self.play), ('Export…', self.export)]:
            button = ttk.Button(row, text=label, command=callback)
            button.pack(side='left', padx=(0, 5))
            self.busy_widgets.append(button)
        self.pause = ttk.Button(frame, text='Pause — keep completed work', command=self.stop, state='disabled')
        self.pause.pack(anchor='w', pady=8)
        retime = ttk.Button(frame, text='Reanalyze speech timing (backs up current script)', command=lambda: self.start(True, reanalyze=True))
        retime.pack(anchor='w', pady=(0, 6))
        self.busy_widgets.append(retime)
        ttk.Label(frame, textvariable=self.status, wraplength=880).pack(anchor='w', pady=6)
        self.log = tk.Text(frame, wrap='word', font=('Consolas', 10), state='disabled')
        self.log.pack(fill='both', expand=True)
        ttk.Label(frame, text='Review voices and translations before sharing. Vocal separation may leave residue; CPU rendering is slow.', wraplength=880).pack(anchor='w', pady=(10, 0))
        window.protocol('WM_DELETE_WINDOW', self.close)
        window.after(200, self.poll)

    def active(self):
        base = Path(self.project.get())
        return base / 'preview-30s' if self.preview.get() else base

    def import_video(self):
        value = filedialog.askopenfilename(filetypes=[('Video', '*.mkv *.mp4 *.mov *.webm *.m4v *.avi')])
        if value:
            self.source.set(value)
            self.project.set(str(ROOT / '.ai-dub/studio-projects' / (Path(value).stem + '-dub')))

    def open_project(self):
        value = filedialog.askdirectory()
        if value:
            folder = Path(value)
            self.preview.set(False)
            self.project.set(value)
            manifest = folder / 'project.json'
            if manifest.exists():
                self.source.set(json.loads(manifest.read_text(encoding='utf8'))['source'])

    def set_busy(self, busy):
        for widget in self.busy_widgets:
            widget.configure(state='disabled' if busy else 'normal')
        self.pause.configure(state='normal' if busy else 'disabled')

    def start(self, analyze, reanalyze=False):
        if not Path(self.source.get()).is_file() or not self.project.get().strip():
            messagebox.showerror('Import needed', 'Choose a video and project folder.')
            return
        args = [sys.executable, '-u', '-m', 'studio.pipeline', '--input', self.source.get(), '--project', str(self.active())]
        if self.preview.get():
            args += ['--seconds', '30']
        if analyze:
            args.append('--analyze')
        if reanalyze:
            args.append('--reanalyze')
        self.set_busy(True)
        self.last_error = None
        self.status.set('Working locally. Completed stages and voice takes are saved automatically.')
        try:
            environment = dict(os.environ, PYTHONIOENCODING='utf-8')
            self.process = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf8', errors='replace', env=environment,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except Exception as error:
            self.set_busy(False)
            messagebox.showerror('Unable to start', str(error))
            return
        process = self.process
        def read():
            for line in process.stdout:
                self.events.put(line)
            self.events.put(('done', process.wait()))
        threading.Thread(target=read, daemon=True).start()

    def poll(self):
        try:
            while True:
                item = self.events.get_nowait()
                if isinstance(item, tuple):
                    self.process = None
                    self.set_busy(False)
                    self.status.set('Completed. Review the script or play/export the result.' if item[1] == 0 else
                                    self.last_error or 'Stopped. Completed work is saved. Review the log, then Render / Resume.')
                else:
                    if item.startswith('ValueError:'):
                        self.last_error = item.removeprefix('ValueError:').strip()
                    self.log.configure(state='normal')
                    self.log.insert('end', item)
                    self.log.see('end')
                    self.log.configure(state='disabled')
        except queue.Empty:
            pass
        self.window.after(200, self.poll)

    def stop(self):
        if self.process and self.process.poll() is None:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                self.process.terminate()
            self.pause.configure(state='disabled')
            self.status.set('Stopping. Resume reuses completed stages; the current stage may restart.')

    def edit(self):
        path = self.active() / 'script.json'
        if not path.exists():
            messagebox.showinfo('Analyze first', 'Analyze the video before reviewing speakers and English lines.')
            return
        dialog = tk.Toplevel(self.window)
        dialog.title('Review speakers, reference times and English lines')
        dialog.geometry('850x600')
        text = tk.Text(dialog, wrap='word', undo=True)
        text.pack(fill='both', expand=True)
        text.insert('1.0', path.read_text(encoding='utf8'))
        def store():
            try:
                from studio.pipeline import save, validate_script
                value = json.loads(text.get('1.0', 'end'))
                duration = json.loads((path.parent / 'project.json').read_text(encoding='utf8'))['duration']
                validate_script(value, duration)
                save(path, value)
                dialog.destroy()
            except Exception as error:
                messagebox.showerror('Check script', str(error), parent=dialog)
        ttk.Label(dialog, text='Edit dubText for natural English that fits the speech window. Keep detected start/end times.\nMerge speakers using their IDs; references need at least 1 second. Save before resuming.').pack()
        ttk.Button(dialog, text='Save reviewed script', command=store).pack(pady=8)
        dialog.transient(self.window)
        dialog.grab_set()

    def result(self):
        path = self.active() / 'AI-Dub-English.mp4'
        report = self.active() / 'report.json'
        from studio.pipeline import digest
        from studio.alignment import ALIGNMENT_VERSION
        script = self.active() / 'script.json'
        if not path.exists() or not report.exists() or not script.exists():
            messagebox.showinfo('Render first', 'No completed video in this project yet.')
            return None
        result_report = json.loads(report.read_text(encoding='utf8'))
        if result_report.get('alignmentVersion') != ALIGNMENT_VERSION or result_report.get('scriptHash') != digest(json.loads(script.read_text(encoding='utf8'))):
            messagebox.showinfo('Render changes', 'The script changed. Render / Resume to update the video first.')
            return None
        return path

    def play(self):
        path = self.result()
        if path:
            os.startfile(path)

    def export(self):
        path = self.result()
        if path:
            value = filedialog.asksaveasfilename(defaultextension='.mp4', initialfile=path.name, filetypes=[('MP4', '*.mp4')])
            if value and Path(value).resolve() != path.resolve():
                shutil.copy2(path, value)
                self.status.set('Exported: ' + value)

    def close(self):
        self.stop()
        if self.process:
            self.process.wait(timeout=10)
        self.window.destroy()


if __name__ == '__main__':
    root = tk.Tk()
    Studio(root)
    root.mainloop()
