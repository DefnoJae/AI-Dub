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
        try:
            session=json.loads((ROOT / '.ai-dub/studio-session.json').read_text(encoding='utf8'))
        except (OSError,ValueError):
            session={}
        self.source = tk.StringVar(value=session.get('source',''))
        self.project = tk.StringVar(value=session.get('project',''))
        self.preview = tk.BooleanVar(value=session.get('preview',True))
        self.voice_mode = tk.StringVar(value=session.get('voice','Automatic: references with consistent fallback'))
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
        voice_row = ttk.Frame(frame)
        voice_row.pack(fill='x', pady=4)
        ttk.Label(voice_row, text='Voices: ').pack(side='left')
        voice_box = ttk.Combobox(voice_row, textvariable=self.voice_mode, state='readonly', width=54,
            values=['Automatic: references with consistent fallback', 'Natural voices: fast and consistent', 'Reference voices only: may need review'])
        voice_box.pack(side='left')
        self.busy_widgets.append(voice_box)
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

    def save_session(self):
        from studio.pipeline import save
        (ROOT / '.ai-dub').mkdir(exist_ok=True)
        save(ROOT / '.ai-dub/studio-session.json',dict(source=self.source.get(),project=self.project.get(),
             preview=self.preview.get(),voice=self.voice_mode.get()))

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
            widget.configure(state='disabled' if busy else ('readonly' if isinstance(widget,ttk.Combobox) else 'normal'))
        self.pause.configure(state='normal' if busy else 'disabled')

    def start(self, analyze, reanalyze=False):
        if not Path(self.source.get()).is_file() or not self.project.get().strip():
            messagebox.showerror('Import needed', 'Choose a video and project folder.')
            return
        self.save_session()
        self.analysis_only=analyze
        args = [sys.executable, '-u', '-m', 'studio.pipeline', '--input', self.source.get(), '--project', str(self.active())]
        mode = {'Automatic': 'automatic', 'Natural voices': 'natural', 'Reference voices only': 'reference'}[self.voice_mode.get().split(':')[0]]
        args += ['--voice-mode', mode]
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
                    self.status.set(('Analysis complete. Review the dialogue, then Render / Resume.' if self.analysis_only else 'Render complete. Play result or Export.') if item[1] == 0 else
                                    self.last_error or 'Stopped. Completed work is saved. Review the log, then Render / Resume.')
                else:
                    if item.startswith(('ValueError:','RuntimeError:')):
                        self.last_error = item.split(':',1)[1].strip()
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

    def edit_json(self):
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

    def edit(self):
        path = self.active() / 'script.json'
        if not path.exists():
            messagebox.showinfo('Analyze first', 'Analyze the video before reviewing dialogue.')
            return
        script = json.loads(path.read_text(encoding='utf8'))
        duration = json.loads((path.parent / 'project.json').read_text(encoding='utf8'))['duration']
        dialog = tk.Toplevel(self.window)
        dialog.title('Review dialogue — no code needed')
        dialog.geometry('1000x650')
        dialog.transient(self.window)
        dialog.grab_set()
        frame = ttk.Frame(dialog, padding=12)
        frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='Select a line, listen to the original, and edit the spoken English. Save when finished.').pack(anchor='w')
        tree = ttk.Treeview(frame, columns=('line','time','speaker','english'), show='headings', height=9, selectmode='browse')
        for key, label, width in [('line','Line',45),('time','Time',140),('speaker','Speaker',120),('english','Spoken English',600)]:
            tree.heading(key, text=label)
            tree.column(key, width=width)
        tree.pack(fill='both', expand=True, pady=8)
        selected = [None]
        start, end, speaker = tk.StringVar(), tk.StringVar(), tk.StringVar()
        details = tk.StringVar()
        row = ttk.Frame(frame)
        row.pack(fill='x')
        for label, variable in [('Start (seconds)',start),('End (seconds)',end),('Speaker ID',speaker)]:
            ttk.Label(row, text=label).pack(side='left', padx=4)
            ttk.Entry(row, textvariable=variable, width=13).pack(side='left')
        ttk.Label(frame, textvariable=details, wraplength=950).pack(anchor='w', pady=8)
        ttk.Label(frame, text='Spoken English (natural wording; retain the meaning)').pack(anchor='w')
        english = tk.Text(frame, height=4, wrap='word', font=('Segoe UI', 12), undo=True)
        english.pack(fill='x', pady=5)
        def refresh():
            for i, line in enumerate(script['lines']):
                values = (i+1,f'{line["start"]:.2f} – {line["end"]:.2f}', line['speaker'], line.get('dubText',line['text']))
                if tree.exists(str(i)):
                    tree.item(str(i), values=values)
                else:
                    tree.insert('', 'end', iid=str(i), values=values)
        def apply():
            if selected[0] is None:
                return
            i = selected[0]
            prior = script['lines'][i]
            line = dict(prior, start=float(start.get()), end=float(end.get()), speaker=speaker.get().strip(),
                        dubText=english.get('1.0','end').strip())
            from studio.pipeline import validate_script
            candidate = dict(script, lines=[line if j==i else value for j,value in enumerate(script['lines'])])
            validate_script(candidate, duration)
            script['lines'][i] = line
            refresh()
        def pick(event=None):
            values = tree.selection()
            if not values:
                return
            try:
                apply()
            except Exception as error:
                messagebox.showerror('Check line', str(error), parent=dialog)
                return
            i = int(values[0])
            selected[0] = i
            line = script['lines'][i]
            start.set(str(line['start']))
            end.set(str(line['end']))
            speaker.set(line['speaker'])
            english.delete('1.0','end')
            english.insert('1.0',line.get('dubText',line['text']))
            details.set('Japanese: ' + line.get('sourceJapanese','Unavailable') + '\nTranslation: ' + line.get('translationDraft',line['text']))
        def store():
            try:
                apply()
                from studio.pipeline import save
                save(path, script)
                dialog.destroy()
            except Exception as error:
                messagebox.showerror('Check dialogue',str(error),parent=dialog)
        def listen():
            try:
                apply()
                line = script['lines'][selected[0]]
                source = json.loads((path.parent / 'project.json').read_text(encoding='utf8'))['source']
                from studio.pipeline import media
                from companion.quality_clip import tools_dir
                output = path.parent / 'review-original.wav'
                media(tools_dir(), ['-ss',max(0,line['start']-.25),'-i',source,'-t',line['end']-line['start']+.5,'-vn'], output)
                os.startfile(output)
            except Exception as error:
                messagebox.showerror('Unable to preview',str(error),parent=dialog)
        actions = ttk.Frame(frame)
        actions.pack(fill='x',pady=8)
        ttk.Button(actions,text='Listen to original line',command=listen).pack(side='left',padx=4)
        ttk.Button(actions,text='Save all dialogue',command=store).pack(side='right',padx=4)
        ttk.Button(actions,text='Cancel',command=dialog.destroy).pack(side='right',padx=4)
        refresh()
        tree.bind('<<TreeviewSelect>>',pick)
        tree.selection_set('0')

    def result(self):
        path = self.active() / 'AI-Dub-English.mp4'
        report = self.active() / 'report.json'
        from studio.pipeline import digest
        from studio.alignment import ALIGNMENT_VERSION, FIT_VERSION
        from studio.rendering import RENDER_VERSION
        script = self.active() / 'script.json'
        if not report.exists() or not script.exists():
            messagebox.showinfo('Render first', 'No completed video in this project yet.')
            return None
        result_report = json.loads(report.read_text(encoding='utf8'))
        filename=result_report.get('outputFile','AI-Dub-English.mp4')
        if not isinstance(filename,str) or Path(filename).name!=filename:
            messagebox.showerror('Invalid result','The report contains an invalid video filename.')
            return None
        path=self.active()/filename
        if not path.is_file():
            messagebox.showinfo('Render first','The completed video file is missing. Render / Resume again.')
            return None
        if result_report.get('fitVersion') != FIT_VERSION or result_report.get('renderVersion') != RENDER_VERSION or result_report.get('alignmentVersion') != ALIGNMENT_VERSION or result_report.get('scriptHash') != digest(json.loads(script.read_text(encoding='utf8'))):
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
        self.save_session()
        self.stop()
        if self.process:
            self.process.wait(timeout=10)
        self.window.destroy()


if __name__ == '__main__':
    root = tk.Tk()
    Studio(root)
    root.mainloop()
