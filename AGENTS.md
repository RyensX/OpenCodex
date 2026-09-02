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
- Include a lowercase scope when the change belongs to a recognizable module or subsystem.
- Omit the scope only for genuinely repository-wide or cross-cutting changes where no single scope is accurate.
- Reuse an established scope instead of introducing a synonym. Common scopes include `compatibility`, `gateway`, `launcher`, `plugin`, `polyfill`, `router`, `test`, `web`, and `web-shell`.
- Use `compatibility` for the runtime compatibility kernel, diagnostics service, and diagnostics interface.
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
fix(compatibility): clarify runtime contribution titles
fix(polyfill): collapse sidebar on new chat
fix(terminal): restore web terminal sessions
chore: switch package manager to pnpm
doc: update README
```
