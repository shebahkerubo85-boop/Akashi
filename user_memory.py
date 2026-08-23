import json
from pathlib import Path

MEMORY_FILE = Path(__file__).parent / "user_memory.json"

def _load() -> dict:
    if MEMORY_FILE.exists():
        try:
            return json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}

def _save(data: dict) -> None:
    MEMORY_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

def remember(user_id: int, name: str, message: str) -> None:
    data = _load()
    uid = str(user_id)
    entry = data.get(uid, {"name": name, "messages": []})
    entry["name"] = name
    entry["messages"].append(message)
    # Keep last 50 messages per user
    entry["messages"] = entry["messages"][-50:]
    data[uid] = entry
    _save(data)

def get_profile(user_id: int) -> str:
    data = _load()
    entry = data.get(str(user_id))
    if not entry or not entry.get("messages"):
        return ""
    return f"Known about {entry['name']}: " + " | ".join(entry["messages"][-10:])
