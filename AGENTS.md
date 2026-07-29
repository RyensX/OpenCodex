# AGENTS.md

## Code Comment Requirements

- 每次写代码时，都必须根据实际逻辑添加适当的中文注释，以提高代码可读性，帮助阅读者快速理清实现思路。

## Local Gateway Credentials

- OpenCodex 本机访问密码只保存于 macOS Keychain：service 为 `opencodex.hifriend.fun`，account 为当前 macOS 用户。需要登录或测试时直接从 Keychain 读取，不再次询问用户；不得把明文密码写入仓库、日志或回复。

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
