"""Local context-aware dialogue drafts; all output is unreviewed."""
import json
import re


class DialogueEditor:
    def __init__(self, folder):
        import torch
        from transformers import AutoTokenizer, AutoModelForCausalLM
        self.tokenizer = AutoTokenizer.from_pretrained(str(folder), local_files_only=True)
        self.model = AutoModelForCausalLM.from_pretrained(str(folder), local_files_only=True,
                                                        torch_dtype=torch.float32).eval()

    def adapt(self, lines):
        """Batch context helps resolve short phrases such as 'about you'."""
        import torch
        inputs = [dict(id=i, japanese=line.get('sourceJapanese', ''),
                       translation=line['text'], seconds=round(line['end']-line['start'], 2),
                       wordBudget=max(2, round((line['end']-line['start']) * 3)))
                  for i, line in enumerate(lines)]
        system = ('You translate Japanese anime dialogue into natural spoken English. '
                  'The Japanese transcript may be imperfect. Use nearby dialogue as context. '
                  'Preserve meaning, who addresses whom, negation and emotion. Do not invent facts. '
                  'Keep each spoken line within its wordBudget. Never omit a line. '
                  'Return ONLY a JSON array with objects {"id":0,"text":"faithful English translation",'
                  '"dubText":"concise conversational English"}. No explanations.')
        prompt = self.tokenizer.apply_chat_template([
            dict(role='system', content=system), dict(role='user', content=json.dumps(inputs, ensure_ascii=False))],
            tokenize=False, add_generation_prompt=True)
        tokens = self.tokenizer(prompt, return_tensors='pt')
        with torch.inference_mode():
            output = self.model.generate(**tokens, do_sample=False, max_new_tokens=1024,
                                         pad_token_id=self.tokenizer.eos_token_id)
        text = self.tokenizer.decode(output[0, tokens['input_ids'].shape[1]:], skip_special_tokens=True)
        self.last_response = text
        match = re.search(r'\[.*\]', text, re.S)
        if not match:
            raise ValueError('Dialogue model returned no valid draft')
        values = json.loads(match[0])
        if isinstance(values,list) and len(values)==len(lines) and all(isinstance(value,str) for value in values):
            values = [dict(id=i,text=lines[i]['text'],dubText=value) for i,value in enumerate(values)]
        if not isinstance(values,list) or any(not isinstance(value,dict) for value in values):
            raise ValueError('Dialogue model returned an invalid structure')
        if len(values) != len(lines) or sorted(v.get('id', -1) for v in values) != list(range(len(lines))):
            raise ValueError('Dialogue draft omitted or duplicated lines')
        by_id = {value['id']: value for value in values}
        for i, line in enumerate(lines):
            value = by_id[i]
            if any(not isinstance(value.get(key), str) or not 0 < len(value[key].strip()) <= 500
                   for key in ('text', 'dubText')):
                raise ValueError('Invalid dialogue draft')
        return [dict(line, translationDraft=by_id[i]['text'], dubText=by_id[i]['dubText'],
                     dialogueSource='local Qwen draft; requires review') for i, line in enumerate(lines)]
