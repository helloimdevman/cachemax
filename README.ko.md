# cachemax

[English](README.md) | **한국어**

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-orange)

자리를 비운 동안 **Claude Code, Codex, Grok Build 대화의 캐시**를 유지합니다.
cachemax는 같은 세션에 짧은 요청을 보내고, 로컬 관리페이지에서 유지 턴을 숨깁니다.
기존 CLI 로그인을 그대로 씁니다.

## 빠른 시작

```sh
npx skills add helloimdevman/cachemax -g -a claude-code codex grok
```

1. 유지하려는 대화에서 Claude Code·Grok Build는 `/cachemax`, Codex는 `$cachemax`를 실행합니다.
2. 최대 요청 횟수(**기본 5회**)와 캐시 TTL(**기본 알 수 없음**)을 고릅니다.
3. **10분 안에 CLI를 종료합니다.** cachemax가 세션을 넘겨받아 브라우저에서 엽니다.
 대화는 그 페이지에서 이어 가세요. 사용자 메시지가 유지 요청보다 우선합니다.

CLI를 종료하기 전에 같은 스킬에 `off`를 붙여 실행하면 취소됩니다.

<details class="orca-details">
<summary>관리 페이지 미리 보기</summary>

![유지 상태와 사용량을 보여 주는 cachemax 관리 페이지](docs/assets/screenshot.png)

</details>

## 실측 캐시 효과와 사용량

![5분~2시간 뒤 복귀 요청의 캐시 읽기 범위와 추가 사용량을 cachemax 사용·미사용으로 비교.](docs/assets/cache-retention.ko.svg)

- **Codex, 2시간:** 미사용 0–15.2%, 사용 99.5%.
- **Grok Build, 15분 이후:** 미사용은 8회 중 7회에서 0–21.6%, 사용은 99.7–99.9%.

## 동작 규칙

- 사용자 메시지가 유지 요청보다 우선합니다.
- 답변이 끝나면 요청 간격을 다시 셉니다.
- 지속 시간·요청 횟수·토큰·비용 한도에 도달하면 멈춥니다.
- 유지 턴은 관리페이지에서 숨기고 호스트 원본 기록에 남깁니다.

## 한도와 기본값


| 설정             | 기본값                          | 범위·간격                 |
| -------------- | ---------------------------- | --------------------- |
| 요청 횟수          | 5회                           | 1–120회                |
| 지속 시간          | 스킬: 요청 횟수에 맞춤; 페이지: 30m      | 최대 24h                |
| 요청 간격          | TTL 알 수 없음·5m → 3m; 1h → 50m | 사용자 지정 TTL → TTL의 5/6 |
| 유지 요청 토큰·비용 한도 | 꺼짐                           | 비용 한도: Claude·Grok    |


<details class="orca-details">
<summary>플러그인 설치와 터미널 명령</summary>

```sh
# 플러그인: 사용하는 호스트 하나
claude plugin marketplace add helloimdevman/cachemax && claude plugin install cachemax@cachemax
codex plugin marketplace add helloimdevman/cachemax && codex plugin add cachemax@cachemax
grok plugin install helloimdevman/cachemax#plugins/cachemax

# 독립 CLI
git clone https://github.com/helloimdevman/cachemax.git && cd cachemax
npm install --global .
cachemax run codex          # 또는 claude, grok
```

`run`은 유지 기능이 **꺼진 상태**로 로컬 대화를 엽니다. TTL·한도를 정하고 **Keep ready**를 누르세요.
기존 세션을 넘기려면 네이티브 클라이언트를 먼저 닫은 뒤 실행합니다.

```sh
cachemax run codex --session ID --cwd /원래/디렉터리 --handoff
```

호스트에서는 스킬(`/cachemax` 또는 `$cachemax`) 뒤에 `[요청 횟수] [ttl]`, `off`, `status`,
`logs`를 붙입니다. 관리 페이지에서는 `/cachemax 30m`, `/cachemax off`, `/cachemax status`,
`/cachemax logs`, `/cachemax show-hidden`을 씁니다. 다른 터미널에서는:

```sh
cachemax on     --host codex --session ID --duration 30m --ttl 5m --max-ticks 5
cachemax off    --host codex --session ID
cachemax status --host codex --session ID      # 모델 요청 없는 조회
cachemax logs   --host codex --session ID
cachemax forget --host codex --session ID      # 중지된 세션 메타데이터 삭제
```

`on`에는 `--max-tokens N`, `--max-cost-usd N`(Claude·Grok만)도 붙일 수 있습니다.
제거하려면 먼저 유지를 끄고 `npx skills remove cachemax -g`를 실행하세요.
플러그인·CLI로 설치했다면 해당 호스트의 플러그인 제거 명령과 `npm uninstall --global cachemax`를 사용하세요.

</details>

[MIT 라이선스](LICENSE)
