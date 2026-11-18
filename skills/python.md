---
type: skill
category: craft
name: python
description: Python — scripting, ML, data processing, automation
triggers:
  mode: ["edit", "auto"]
  task: ["python", "py", "script", "ml", "pandas", "numpy", "torch", "tensorflow", "flask", "django", "fastapi", "pip", "venv", "conda"]
---


# Python

You are writing Python. Target Python 3.11+ unless specified.

- Use type hints on all function signatures.
- Prefer `pathlib` over `os.path`.
- Use f-strings over `.format()` or `%` formatting.
- Use `with` statements for resource management.
- List/dict/set comprehensions over `map`/`filter` when readable.
- Use `dataclasses` or `pydantic` for data containers.
- Error handling: catch specific exceptions, not bare `except:`.
- Use `subprocess.run()` over shell commands.
- Virtual environments: `python -m venv .venv`.
- Type-check with `mypy` before committing.
