# v2.4.0

2.3.9 바로 뒤에 나온 짧은 릴리즈입니다. **일부 PC 에서 탭을 옮길 때마다 화면이 흔들리던 문제**를
고쳤고, AI Chat 의 CLI 설치 안내를 최신 방법으로 바꿨습니다.

## 📜 탭을 전환하면 화면이 움직였다 돌아오던 문제

로그를 위로 올려 읽는 중에 **미니탭 · 워크스페이스 · 분할창**을 전환하면 화면이 잠깐 움직였다가
제자리로 돌아왔습니다. 읽던 자리는 결국 유지되지만 매번 흔들려 눈에 거슬렸습니다.

**Windows 11 에서는 보이지 않고 Windows 10 에서만 보였습니다.** 원래 두 경로 모두 "잘못된 위치를
먼저 그린 뒤 고치는" 순서였는데, 빠른 PC 에서는 그 사이에 화면이 그려지지 않아 눈에 띄지 않았을
뿐입니다. 이제 **고친 뒤에 그리도록** 순서를 바꿨습니다.

| 어디서 | 무엇이 |
|---|---|
| 분할창 전환 · 창 크기 변경 | 스크롤바를 다시 그리게 하려고 화면을 1px 움직였다 되돌리던 처리 — 스크롤을 올려둔 상태에서는 하지 않습니다 |
| 미니탭 · 워크스페이스 전환 | 터미널을 숨겨둘 때 스크롤 위치가 초기화되어, 돌아올 때 맨 위가 먼저 보였습니다 — 위치를 되돌린 뒤 보여줍니다 |

맨 아래를 보고 있을 때의 동작(새 출력을 따라가고 스크롤바가 정상으로 갱신되는 것)은 그대로입니다.

## 🤖 AI Chat — CLI 설치 안내를 최신 방법으로

Claude Code / Codex CLI 가 없을 때 `npm install -g ...` 만 안내하고 있었습니다. 이제 각 서비스가
권장하는 **공식 설치 스크립트**를 먼저 보여주고, **쓰고 있는 운영체제의 명령만** 표시합니다.

**Claude Code**

```
Windows  PowerShell  irm https://claude.ai/install.ps1 | iex
         cmd         curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
macOS    Terminal    curl -fsSL https://claude.ai/install.sh | bash
```

**Codex**

```
Windows  PowerShell  powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
macOS    Homebrew    brew install codex
```

- **설치 안내 문서 열기** 링크가 추가됐습니다 — 누르면 기본 브라우저에서 열립니다
- Codex 는 `npm install -g @openai/codex` 도 대안으로 함께 적어뒀습니다. 사내망에서 설치 스크립트
  실행이 막히는 경우가 있습니다
- 명령은 드래그해서 그대로 복사할 수 있습니다

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.4.0.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.4.0-portable.exe` (포터블)
