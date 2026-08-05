# office-editor 번들에 적용한 수정 사항

이 폴더는 ZIZIYI Office 편집기(Next.js 빌드 결과 + ONLYOFFICE sdkjs)를 자체 호스팅한 것이다.
번들을 새 버전으로 교체하면 아래 수정이 사라지므로 다시 적용해야 한다.

## 1. 같은 출처(origin) URL 은 브라우저 확장 없이 바로 열기

**파일**: `_next/static/chunks/d53828b24e48e7b5.js`

**원본**

```js
if(h.startsWith("blob:"))e.openUrl(h,{fileType:...,fileName:...});else{
  let{loader:t,tryDirect:n}=(0,l.createExtensionLoader)({onWaiting:()=>p(!0),onReady:()=>p(!1)});
  ...
}
```

**수정**

```js
if(h.startsWith("blob:")||h.startsWith(location.origin)||h.startsWith("/"))e.openUrl(...);else{...}
```

**이유**

편집기는 `blob:` URL 이 아닌 문서 주소를 받으면 브라우저 확장 프로그램 로더를 태우고, 그 과정에서
"확장 프로그램 필요 / 확장 프로그램 설치" 팝업을 띄운다(`onWaiting` → 다이얼로그).

- 이 앱은 Electron 이라 크롬 웹스토어가 없다 — "확장 프로그램 설치" 를 눌러도 아무 일도 일어나지
  않는다(설치할 수단 자체가 없다).
- 우리는 확장이 필요하지 않다. 문서를 `pepeapp://app/__local-file?path=...`(패키지) 또는
  `http://localhost:5173/__local-file?path=...`(dev) 로 **같은 출처에서 직접 서빙**하므로 편집기가
  그냥 fetch 하면 된다. 팝업의 "확장 프로그램 없이 열어보기" 가 하는 일과 같은 경로다.
- 예전에는 파일 바이트로 `blob:` URL 을 만들어 넘겨서 이 분기에 걸리지 않았다. 오피스 워크스페이스를
  `<iframe>` 에서 `<webview>`(별도 프로세스)로 옮기면서 `blob:` 을 쓸 수 없게 됐다 — `blob:` 은 만든
  컨텍스트에서만 유효해서 다른 프로세스인 게스트가 열 수 없다. 그때부터 이 팝업이 뜨기 시작했다.

`location.origin` 과 `/` 두 가지를 모두 허용하는 이유: 우리 쪽 URL 이 절대 주소(dev/패키지 모두
같은 출처)로 만들어지지만, 상대 주소로 바뀌어도 동작하게 두었다.

**안전망**: `src/components/ZiziyiOfficeWorkspace.tsx` 가 게스트에 스크립트를 주입해, 혹시 이 팝업이
뜨면 "확장 프로그램 없이 열어보기" 를 자동으로 누른다. 위 수정이 유효하면 그 코드는 아무 일도 하지
않는다 — 번들을 갱신했는데 수정을 다시 적용하지 못했을 때를 위한 대비책이다.
