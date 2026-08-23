"""Fetches Sanin README + latest release notes from GitHub and appends them to system_prompt.md."""
import urllib.request
import json
from pathlib import Path

PROMPT_FILE = Path(__file__).parent / "system_prompt.md"
REPO_API = "https://api.github.com/repos/shebahkerubo85-boop/Orochimaru"

def fetch(url: str, accept: str = "application/vnd.github.v3.raw") -> str:
    req = urllib.request.Request(url, headers={"Accept": accept})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode()

def main() -> None:
    prompt = PROMPT_FILE.read_text(encoding="utf-8")

    marker = "## Live Repo Data (auto-updated)"
    if marker in prompt:
        prompt = prompt[:prompt.index(marker)].rstrip()
    else:
        prompt = prompt.rstrip()

    sections = [prompt]

    try:
        readme = fetch(f"{REPO_API}/readme")
        sections.append(f"\n{marker}\n\n### README (latest from repo)\n\n{readme[:8000]}")
    except Exception as e:
        print(f"README fetch failed: {e}")

    try:
        releases_raw = fetch(f"{REPO_API}/releases/latest", accept="application/vnd.github.v3+json")
        release = json.loads(releases_raw)
        notes = release.get("body", "") or "No release notes"
        tag = release.get("tag_name", "")
        sections.append(f"\n### Latest Release ({tag})\n\n{notes[:3000]}")
    except Exception as e:
        print(f"Release fetch failed: {e}")

    PROMPT_FILE.write_text("\n".join(sections), encoding="utf-8")
    print("Knowledge updated.")

if __name__ == "__main__":
    main()
