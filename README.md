# 2026 FIFA World Cup Group Dashboard

정적 웹 배포용 월드컵 조별리그 현황판입니다.

## 구성

- `index.html`: 현황판 UI
- `wc2026_live_data.js`: 최신 조별리그 데이터
- `scripts/update-live-data.mjs`: 공개 API에서 조별리그 데이터를 받아 `wc2026_live_data.js` 갱신
- `.github/workflows/update-live-data.yml`: GitHub Actions에서 5분마다 데이터 갱신

## GitHub Pages 배포

1. 이 폴더 내용을 새 GitHub 저장소 루트에 업로드합니다.
2. GitHub 저장소의 `Settings > Pages`에서 `Deploy from a branch`를 선택합니다.
3. Branch는 `main`, folder는 `/root`로 선택합니다.
4. `Actions` 탭에서 `Update WC2026 Live Data`를 한 번 수동 실행하면 초기 데이터가 생성됩니다.
5. 이후 GitHub Actions가 5분마다 데이터를 갱신합니다.

## Cloudflare Pages / Netlify

GitHub 저장소를 연결하고 정적 사이트로 배포하면 됩니다.

- Build command: 비워둠
- Publish directory: `.`

GitHub Actions가 `wc2026_live_data.js`를 갱신하고 커밋하면, 연결된 Pages/Netlify가 자동 재배포합니다.

## 주의

- 화면은 5분마다 자동 새로고침됩니다.
- 데이터 소스가 응답하지 않으면 마지막으로 저장된 `wc2026_live_data.js` 기준으로 표시됩니다.
- 국기 이모지는 사용하지 않습니다.
