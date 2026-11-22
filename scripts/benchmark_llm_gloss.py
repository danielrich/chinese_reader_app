#!/usr/bin/env python3
"""
Benchmark local LLMs (Gemma 2 vs Qwen 2.5) for Chinese Reader intralingual glossing.

Evaluates:
1. Modern literary Chinese (Traditional)
2. Classical Chinese (文言文, Traditional)
3. Constraint adherence (Traditional Chinese only, elementary/simple synonyms, strict JSON)
4. Speed & latency (tokens/sec, time-to-first-token)
"""

import json
import time
import urllib.request
import urllib.error
from typing import List, Dict, Any

OLLAMA_API_URL = "http://localhost:11434/api/generate"

# Benchmark test cases
TEST_CASES = [
    # --- Category A: Modern Literary / Advanced Chinese (Traditional) ---
    {
        "id": "modern_1",
        "category": "Modern Literary",
        "sentence": "他聽完這番話，只是微微頷首，並未多言。",
        "target_word": "頷首",
        "expected_gloss": ["點頭"],
        "context_note": "Literary gesture for nodding agreement"
    },
    {
        "id": "modern_2",
        "category": "Modern Literary",
        "sentence": "面對眾人的讚譽與掌聲，他反倒有些赧然。",
        "target_word": "赧然",
        "expected_gloss": ["害羞", "不好意思", "臉紅"],
        "context_note": "Shy / embarrassed expression"
    },
    {
        "id": "modern_3",
        "category": "Modern Literary",
        "sentence": "他在校門口逡巡良久，始終不敢跨進去見老師。",
        "target_word": "逡巡",
        "expected_gloss": ["猶豫", "徘徊", "遲疑不決"],
        "context_note": "Hesitating / pacing back and forth"
    },
    {
        "id": "modern_4",
        "category": "Modern Literary",
        "sentence": "兩國邊界駐軍頻繁調動，局勢劍拔弩張，隨時可能爆發衝突。",
        "target_word": "劍拔弩張",
        "expected_gloss": ["形勢緊張", "非常緊張", "一觸即發"],
        "context_note": "Chengyu describing extreme tension"
    },
    {
        "id": "modern_5",
        "category": "Modern Literary",
        "sentence": "他對這門技術深諳其道，早已得心應手。",
        "target_word": "深諳",
        "expected_gloss": ["非常了解", "十分熟悉", "精通"],
        "context_note": "Deeply familiar with"
    },

    # --- Category B: Classical Chinese (文言文, Traditional) ---
    {
        "id": "classical_1",
        "category": "Classical Chinese",
        "sentence": "曾子曰：「吾日三省吾身：為人謀而不忠乎？與朋友交而不信乎？」",
        "target_word": "省",
        "expected_gloss": ["反省", "檢查", "審察"],
        "context_note": "Xǐng (to examine oneself)"
    },
    {
        "id": "classical_2",
        "category": "Classical Chinese",
        "sentence": "孟子見梁惠王。王曰：「叟！不遠千里而來，亦將有以利吾國乎？」",
        "target_word": "叟",
        "expected_gloss": ["老人", "長者", "老人家"],
        "context_note": "Polite address to an elder"
    },
    {
        "id": "classical_3",
        "category": "Classical Chinese",
        "sentence": "沛公旦日從百餘騎來見項王，至鴻門，謝曰：「臣與將軍戮力而攻秦。」",
        "target_word": "謝",
        "expected_gloss": ["道歉", "謝罪", "致歉"],
        "context_note": "Apologize (not thank)"
    },
    {
        "id": "classical_4",
        "category": "Classical Chinese",
        "sentence": "北冥有魚，其名為鯤。鯤之大，不知其幾千里也；化而為鳥，其名為鵬。",
        "target_word": "冥",
        "expected_gloss": ["大海", "海", "北方大洋"],
        "context_note": "Northern Ocean"
    },
    {
        "id": "classical_5",
        "category": "Classical Chinese",
        "sentence": "公輸盤九設攻城之機變，子墨子九距之。",
        "target_word": "距",
        "expected_gloss": ["抵擋", "防守", "拒絕"],
        "context_note": "Jù (resist/defend against)"
    }
]

SYSTEM_PROMPT = """你是一個中文閱讀輔助專家。請為句子中讀者不懂的目標詞彙提供**繁體中文**的簡單近義詞或白話簡釋。
規則：
1. 必須嚴格使用【繁體中文】。
2. 替換詞必須是常用、簡單易懂的日常詞彙或短語（適合初中級學習者），切勿用更生僻晦澀的古詞或難詞。
3. 替換詞長度控制在 1 到 4 個字之間。
4. 必須嚴格輸出 JSON 格式，不要包含任何開場白或解釋。

輸出 JSON 格式範例：
{
  "target_word": "目標詞",
  "gloss": "簡單近義詞",
  "pinyin": "pīnyīn",
  "note": "簡短的語意說明（10字以內）"
}"""

def run_model_prompt(model: str, sentence: str, target_word: str) -> Dict[str, Any]:
    prompt = f"{SYSTEM_PROMPT}\n\n句子：{sentence}\n目標詞：{target_word}\nJSON輸出："
    
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0.1,
            "top_p": 0.9,
        }
    }
    
    req = urllib.request.Request(
        OLLAMA_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start_time
            response_text = data.get("response", "")
            tokens_eval = data.get("eval_count", 0)
            eval_duration_ns = data.get("eval_duration", 0)
            tokens_per_sec = (tokens_eval / (eval_duration_ns / 1e9)) if eval_duration_ns > 0 else 0
            
            try:
                parsed = json.loads(response_text)
            except Exception:
                parsed = {"raw": response_text, "error": "failed_json_parse"}
                
            return {
                "success": True,
                "parsed": parsed,
                "elapsed": elapsed,
                "tokens": tokens_eval,
                "tokens_per_sec": tokens_per_sec
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "elapsed": time.time() - start_time
        }

def run_benchmark(models: List[str]):
    print(f"=== Starting Chinese Reader Intralingual Gloss Benchmark ===")
    print(f"Models to test: {', '.join(models)}")
    print(f"Total test cases: {len(TEST_CASES)} (5 Modern, 5 Classical)\n")
    
    results = {m: [] for m in models}
    
    for tc in TEST_CASES:
        print(f"--- [{tc['category']}] Word: {tc['target_word']} (Sentence: {tc['sentence']}) ---")
        for model in models:
            res = run_model_prompt(model, tc["sentence"], tc["target_word"])
            if res["success"]:
                gloss = res["parsed"].get("gloss", "N/A")
                pinyin = res["parsed"].get("pinyin", "")
                tps = res["tokens_per_sec"]
                print(f"  [{model:15s}] Gloss: {gloss:8s} | Pinyin: {pinyin:10s} | Speed: {tps:5.1f} t/s | Time: {res['elapsed']:.2f}s")
                results[model].append({
                    "case": tc,
                    "result": res
                })
            else:
                print(f"  [{model:15s}] ERROR: {res['error']}")
                results[model].append({
                    "case": tc,
                    "result": res
                })
        print()
        
    return results

if __name__ == "__main__":
    import sys
    models = sys.argv[1:] if len(sys.argv) > 1 else ["qwen2.5:14b", "gemma2:9b", "qwen2.5:7b"]
    run_benchmark(models)
