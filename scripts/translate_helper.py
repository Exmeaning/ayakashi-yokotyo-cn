import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCENES_FILE = ROOT / "i18n" / "scenes_raw.json"
SOURCE_FILE = ROOT / "i18n" / "source.ja.json"
ZH_FILE = ROOT / "i18n" / "zh-Hans.json"
ENDINGS_FILE = ROOT / "i18n" / "endings_raw.json"

def get_scenes():
    with open(SCENES_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def get_source():
    with open(SOURCE_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def get_zh():
    with open(ZH_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_zh(data):
    with open(ZH_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

def print_scene(scene_name):
    scenes = get_scenes()
    if scene_name not in scenes:
        print(f"Scene {scene_name} not found")
        return
    items = scenes[scene_name]
    print(f"=== {scene_name} ({len(items)} items) ===")
    for i, item in enumerate(items):
        speaker = item.get('name', '')
        text = item.get('text', '')
        choices = item.get('choices', [])
        print(f"{i}: [{speaker}]")
        print(f"    JA: {repr(text)}")
        if choices:
            print(f"    CHOICES: {choices}")

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        for s in sys.argv[1:]:
            print_scene(s)
    else:
        zh = get_zh()
        untranslated = 0
        total = 0
        for k, v in zh.items():
            if k.startswith('_') or not isinstance(v, dict):
                continue
            for ja, tr in v.items():
                total += 1
                if not tr.strip():
                    untranslated += 1
        print(f"Progress: {total - untranslated}/{total} translated ({untranslated} remaining)")
