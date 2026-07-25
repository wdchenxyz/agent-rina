#!/usr/bin/env python3
"""Run the managed DOCX renderer with a CJK font in its temp LO profile.

The bundled headless LibreOffice build intentionally sees only fonts inside
its app bundle or current user profile. This wrapper keeps the managed
render_docx.py unchanged and stages Arial Unicode MS into each disposable
profile before conversion.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path


RENDERER = Path(
    "/Users/wdchen/.codex/plugins/cache/openai-primary-runtime/"
    "documents/26.723.12215/skills/documents/render_docx.py"
)
FONT_CANDIDATES = (
    Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
    Path("/Library/Fonts/Arial Unicode.ttf"),
)


def main() -> None:
    font = next((path for path in FONT_CANDIDATES if path.exists()), None)
    if font is None:
        raise SystemExit("Arial Unicode MS was not found on this Mac.")

    spec = importlib.util.spec_from_file_location("managed_render_docx", RENDERER)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Unable to load managed renderer: {RENDERER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    original_build_lo_env = module._build_lo_env

    def build_lo_env_with_cjk(user_profile: str):
        profile_font_dir = Path(user_profile) / "user" / "fonts"
        profile_font_dir.mkdir(parents=True, exist_ok=True)
        # copyfile avoids carrying macOS system-font flags into /private/tmp.
        shutil.copyfile(font, profile_font_dir / "ArialUnicode.ttf")
        return original_build_lo_env(user_profile)

    module._build_lo_env = build_lo_env_with_cjk
    module.main()


if __name__ == "__main__":
    main()
