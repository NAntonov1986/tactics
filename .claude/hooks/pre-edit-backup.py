#!/usr/bin/env python3
"""
PreToolUse hook: копирует затрагиваемый файл в .edit-backups/<timestamp>/<rel-path>
перед каждым вызовом Edit / Write / MultiEdit / NotebookEdit.

Запускается Claude Code: stdin = JSON с tool_input.file_path (для блокнотов —
notebook_path). Hook молча выходит 0, если файла нет (например, Write создаёт
новый файл — бекапить нечего) или путь вне проекта.

Никогда не блокирует операцию: любая ошибка → exit 0, чтобы не мешать работе.
"""
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0  # некорректный stdin — не мешаем

    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not file_path:
        return 0

    src = Path(file_path)
    if not src.is_file():
        return 0  # новый файл / уже удалён — бекапить нечего

    project_root = Path.cwd().resolve()
    src_abs = src.resolve()

    # Относительный путь от корня проекта; если файл вне корня — кладём по basename.
    try:
        rel = src_abs.relative_to(project_root)
    except ValueError:
        rel = Path(src_abs.name)

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = project_root / ".edit-backups" / timestamp / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_abs, dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
