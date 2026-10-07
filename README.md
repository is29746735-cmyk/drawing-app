# 보관함

그리고 싶은 것(아이디어)과 그릴 때 참고할 사진(자료)을 모아두는 나만의 휴대폰 앱.
자세한 계획은 [기획서.md](기획서.md).

- **폰 설치 주소:** https://is29746735-cmyk.github.io/drawing-app/
- `main`에 올리면(push) 1~2분 뒤 이 주소에 자동으로 반영된다 (GitHub Pages).

## PC에서 미리 보기

```bash
node tools/serve.mjs
```

브라우저에서 http://localhost:5173 을 연다.

## 파일 안내

| 파일 | 하는 일 |
|---|---|
| `index.html` | 화면 뼈대 |
| `styles.css` | 생김새 (색·글꼴·배치) |
| `app.js` | 버튼을 누르면 일어나는 일 전부 |
| `db.js` | 휴대폰 안 저장소 |
| `sw.js` | 인터넷 없이 열기, "공유 → 보관함" 받기 |
| `manifest.webmanifest` | 홈 화면 설치용 이름·아이콘 |
| `tools/make-icons.mjs` | 앱 아이콘 다시 만들기 |
