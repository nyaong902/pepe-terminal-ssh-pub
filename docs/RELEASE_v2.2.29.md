# v2.2.29

## 차등 다운로드 비활성화 — EBUSY 다운로드 실패 수정

v2.2.27 → v2.2.28 자동 업데이트 테스트 중, 다운로드 단계에서 아래 에러로 실패하는 것이 확인됐습니다:

```
EBUSY: resource busy or locked, open 'C:\Users\db080\AppData\Local\pepe terminal(ssh)-updater\pending\0-temp-PePe-Terminal-SSH-Setup-2.2.28.exe'
```

`0-temp-...`는 electron-updater의 **차등 다운로드**(변경된 블록만 받아 기존 파일에 조립하는 방식)가 쓰는 내부 임시 파일입니다. 이 블록 조립 과정에서 파일 잠금 문제가 나는 것으로 보이며(백신 격리는 아님을 확인함), 실패 시 임시 파일이 정리되면서 pending 폴더에 아무것도 안 남는 것도 이 때문입니다.

`electron/updater.ts`에서 `autoUpdater.disableDifferentialDownload = true`로 설정해 차등 다운로드를 완전히 끄고, 항상 전체 설치 파일(~350MB)을 새로 받도록 했습니다. 다운로드 용량은 늘지만 이 블록 조립 코드 경로 자체가 없어져 안정적입니다.

이 버전 자체는 (v2.2.27 기준으로 실행 중일 때) 아직 elevate.exe 우회(sudo-prompt, v2.2.28에서 추가) 수정을 테스트해보지 못한 상태이므로, v2.2.29 다운로드/설치가 정상이면 그게 바로 그 테스트가 됩니다.

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.29.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.29-portable.exe` (포터블)
