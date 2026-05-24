# AGENTS.md

## Code Comment Requirements

- 每次写代码时，都必须根据实际逻辑添加适当的中文注释，以提高代码可读性，帮助阅读者快速理清实现思路。

## Commit Requirements

Follow the existing commit style in this repository.

Use Conventional Commit-style messages:

```text
<type>[(scope)]: <summary>
```

Rules:

- Use English commit messages.
- Keep the subject to one concise line.
- Use a lowercase type.
- Add a scope only when it helps identify the touched area, for example `polyfill` or `terminal`.
- Do not end the subject with a period.
- Keep each commit focused on one logical change.

Common types used in this repo:

- `feat`: user-facing feature or new capability.
- `fix`: bug fix or behavior correction.
- `chore`: tooling, dependencies, build setup, or maintenance.
- `doc`: documentation-only changes.

Examples from the existing history:

```text
feat: load gateway password from config
fix(polyfill): collapse sidebar on new chat
fix(terminal): restore web terminal sessions
chore: switch package manager to pnpm
doc: update README
```
