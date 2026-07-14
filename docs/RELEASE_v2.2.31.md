# v2.2.31

## sudo-prompt 자체가 깨진 패키지였음 — PowerShell Start-Process 직접 호출로 교체

v2.2.28 → v2.2.30에서 elevate.exe를 우회하려고 도입한 `sudo-prompt` 패키지가, 현장 로그로 확인한 결과 호출하자마자 즉시 예외를 던지고 있었습니다:

```
sudo-prompt 승격 실행 예외: TypeError: Node.util.isObject is not a function
    at Object.Exec [as exec] (...\node_modules\sudo-prompt\index.js:43:19)
```

`sudo-prompt`(9.2.1)가 내부적으로 쓰는 `Node.util.isObject`/`isFunction`은 Node.js에서 오래전에 deprecated됐다가, Electron 42가 내장한 최신 Node 버전에서 완전히 제거되어 있습니다. 즉 이 패키지 자체가 지금 Electron 버전과 근본적으로 호환되지 않습니다.

`electron/updater.ts`에서 `sudo-prompt`를 완전히 걷어내고, 그 패키지가 Windows에서 내부적으로 하는 것과 동일한 방식 — PowerShell `Start-Process -Verb RunAs`를 직접 호출하는 `elevatedRunWindows()` 헬퍼를 새로 작성해 사용합니다. 외부 패키지 없이 Node 내장 `child_process.spawn`만 사용하므로 이런 호환성 문제에서 자유롭습니다.

**참고**: VPN 연결(`vpnService.ts`)도 같은 `sudo-prompt`를 동일한 3-인자 호출 방식으로 쓰고 있어 마찬가지로 깨져있을 가능성이 높습니다 — 별도 작업으로 분리해뒀습니다(이번 버전에서는 손대지 않음).

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.31.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.31-portable.exe` (포터블)
