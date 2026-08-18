# -*- coding: utf-8 -*-
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Add scripts to path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from i18n_data.data_common import CHOICES, ENDING_TITLES, ENDING_HINTS
from i18n_data.data_opening import DIALOGUE_OPENING
from i18n_data.data_routeA import DIALOGUE_ROUTE_A
from i18n_data.data_routeB import DIALOGUE_ROUTE_B
from i18n_data.data_routeC import DIALOGUE_ROUTE_C
from i18n_data.data_routeD import DIALOGUE_ROUTE_D
from i18n_data.data_routeE import DIALOGUE_ROUTE_E

ZH_FILE = ROOT / "i18n" / "zh-Hans.json"
SOURCE_FILE = ROOT / "i18n" / "source.ja.json"

def main():
    with open(ZH_FILE, 'r', encoding='utf-8') as f:
        zh_data = json.load(f)

    with open(SOURCE_FILE, 'r', encoding='utf-8') as f:
        source_data = json.load(f)

    # Merge dialogue translations
    all_dialogues = {}
    for d in [DIALOGUE_OPENING, DIALOGUE_ROUTE_A, DIALOGUE_ROUTE_B, DIALOGUE_ROUTE_C, DIALOGUE_ROUTE_D, DIALOGUE_ROUTE_E]:
        all_dialogues.update(d)

    print(f"Total defined dialogue translations: {len(all_dialogues)}")

    # Update choice
    for ja, zh in CHOICES.items():
        if ja in zh_data["choice"]:
            zh_data["choice"][ja] = zh

    # Update ending-title
    for ja, zh in ENDING_TITLES.items():
        if ja in zh_data["ending-title"]:
            zh_data["ending-title"][ja] = zh

    # Update ending-hint
    for ja, zh in ENDING_HINTS.items():
        if ja in zh_data["ending-hint"]:
            zh_data["ending-hint"][ja] = zh

    # Update dialogue
    missing_dialogues = []
    for ja in zh_data["dialogue"]:
        if ja in all_dialogues:
            zh_data["dialogue"][ja] = all_dialogues[ja]
        else:
            missing_dialogues.append(ja)

    print(f"Missing dialogues in translation dictionary: {len(missing_dialogues)}")
    if missing_dialogues:
        print("First 10 missing dialogues:")
        for m in missing_dialogues[:10]:
            print("  ", repr(m))

    # Check overall progress
    total = 0
    translated = 0
    by_kind = {}
    for kind, group in zh_data.items():
        if kind.startswith('_') or not isinstance(group, dict):
            continue
        by_kind[kind] = {"total": len(group), "translated": 0}
        for ja, zh in group.items():
            total += 1
            if zh.strip():
                translated += 1
                by_kind[kind]["translated"] += 1

    print("\n--- Summary by Kind ---")
    for kind, stats in by_kind.items():
        print(f"  {kind:15} {stats['translated']:4}/{stats['total']:4} ({stats['translated']/stats['total']*100:.1f}%)")

    print(f"\nOverall: {translated}/{total} ({translated/total*100:.1f}%)")

    with open(ZH_FILE, 'w', encoding='utf-8') as f:
        json.dump(zh_data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Saved to {ZH_FILE}")

if __name__ == "__main__":
    main()
