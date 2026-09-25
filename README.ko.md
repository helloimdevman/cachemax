# Cache Keeper

[English](README.md) | **한국어**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-orange)

Cache Keeper는 자리를 비운 동안 Claude Code, Codex, Grok Build의 **같은 대화**에
짧고 제한된 유지(maintenance) 요청을 보냅니다. TTL, 간격, 지속 시간, 한도를 직접
정하고, 실제 완료 결과와 유지 요청 사용량을 확인할 수 있습니다.
관리 페이지는 `Only .`를 보내고 유지 턴을 숨깁니다. `.`를 포함해 사용자가 직접 보낸
메시지는 그대로 보이며, 호스트의 원본 대화 기록은 보존됩니다.

> [!WARNING]
> **유지 요청은 로그인된 계정을 사용하므로 전체 비용이 늘어날 수 있습니다.** 점(`.`) 하나로
> 응답하더라도 대화 컨텍스트는 그대로 읽힙니다. 비용 절감, 사용량 0에 가까운 동작,
> 제공자 캐시 유지는 보장되지 않습니다. 선택한 TTL은 로컬 스케줄링의 기준일 뿐,
> 제공자의 캐시 수명을 바꾸지 않습니다.

## 목차

- [요구 사항](#요구-사항)
- [플러그인 설치](#플러그인-설치)
- [실행](#실행)
- [제어](#제어)
- [지원 경로](#지원-경로)
- [개인정보와 제거](#개인정보와-제거)
- [개발](#개발)
- [라이선스](#라이선스)

## 요구 사항

- Node.js **22.18 이상**
- macOS 또는 Linux
- 로그인된 호스트 CLI (Claude Code, Codex, Grok Build 중 하나)

API 키, 인증 정보 내보내기, npm 의존성, 빌드 단계는 필요하지 않습니다.

## 플러그인 설치

이 저장소에는 두 가지 마켓플레이스 형식과 독립 실행 가능한 플러그인
[`plugins/cache-keeper`](plugins/cache-keeper)가 들어 있습니다. 모든 런타임 경로는
설치된 플러그인 기준의 상대 경로입니다.

**Claude Code**

```sh
claude plugin marketplace add Oct7/cachemax
claude plugin install cache-keeper@cache-keeper
```

**Codex**

```sh
codex plugin marketplace add Oct7/cachemax
codex plugin add cache-keeper@cache-keeper
```

**Grok Build**

```sh
grok plugin install Oct7/cachemax#plugins/cache-keeper
```

호스트를 재시작한 뒤 `cache-keeper` 스킬을 호출하세요. 이 스킬은 이미 관리 중인
세션을 제어하거나, 현재 네이티브 세션을 넘기기 위한 handoff 명령을 알려 줍니다.
실행 중인 네이티브 채팅에 몰래 다른 writer를 붙이지 않습니다.

<details>
<summary>로컬 checkout에서 설치 (테스트용)</summary>

```sh
git clone https://github.com/Oct7/cachemax.git && cd cachemax
claude plugin marketplace add "$PWD"
codex plugin marketplace add .
grok plugin install ./plugins/cache-keeper
```

</details>

## 실행

checkout에서 CLI를 설치합니다.

```sh
git clone https://github.com/Oct7/cachemax.git && cd cachemax
npm install --global .
cache-keeper doctor
cache-keeper run claude
# 또는: cache-keeper run codex / cache-keeper run grok
```

전역 설치 없이 실행:

```sh
node plugins/cache-keeper/scripts/cli.mjs run codex
```

runner가 출력한 비공개 localhost URL을 여세요. keepalive는 **꺼진 상태**로 시작합니다.
TTL(**Unknown**, **5 minutes**, **1 hour**, **Custom**), 지속 시간, 간격, 한도를
고른 뒤 **Keep ready**를 누르세요. 기본값은 **30분**, **요청 10회**이고, TTL을 모를 때
간격은 **3분**입니다. 유지 상태 화면에는 마지막 성공 시각, 다음 예정 요청, 결과,
토큰, 예상 비용이 표시됩니다. **Activity**에서는 원시 기록을, **Show hidden turns**에서는
원본 대화 기록을 볼 수 있습니다. 상태와 로그를 확인할 때는 모델 요청을 보내지 않습니다.

### 기존 세션 넘기기 (handoff)

기존 네이티브 세션은 먼저 진행 중인 턴을 끝내고 닫아야 합니다.

```sh
cache-keeper run codex --session SESSION_ID --cwd /path/to/project --handoff
```

원래 디렉터리와 모델을 그대로 사용하세요. runner가 세션을 소유하는 동안에는 네이티브
클라이언트를 닫아 두어야 합니다. Cache Keeper 잠금은 두 번째 runner를 거부하지만,
네이티브 클라이언트는 이 잠금에 참여하지 않습니다. handoff는 이전 writer가 종료되었다는
명시적인 선언입니다. 이전에 소유했던 세션은 `--session`으로 다시 열 수 있으며,
유료 유지 요청은 절대 자동으로 재시작되지 않습니다.

## 제어

관리 페이지에서 사용할 수 있는 명령:

```text
/cache-keeper 30m
/cache-keeper off
/cache-keeper status
/cache-keeper logs
/cache-keeper show-hidden
```

다른 터미널에서 실행 중인 runner를 제어할 수 있습니다.

```sh
cache-keeper on --host codex --session SESSION_ID --duration 30m --ttl 5m --max-ticks 10
# 선택 사항: 캐시된 입력을 포함한 유지 요청 토큰 한도
cache-keeper on --host codex --session SESSION_ID --ttl 5m --max-tokens 100000
# 달러 한도는 보고된 추정치를 사용합니다 (Claude / Grok 전용)
cache-keeper on --host grok --session SESSION_ID --ttl 1h --duration 2h --max-cost-usd 0.10
cache-keeper off --host codex --session SESSION_ID
cache-keeper status --host codex --session SESSION_ID
cache-keeper logs --host codex --session SESSION_ID
```

### 지속 시간과 요청 한도

| 설정 | 기본값 | 최대값 |
| --- | --- | --- |
| 지속 시간 | 30분 | 24시간 |
| 유지 요청 횟수 | 10 | 120 |

활성화하는 순간 종료 시각이 고정되며, 사용자 활동으로 연장되지 않습니다. 첫 유지 요청은
간격만큼 기다린 뒤 보냅니다. 절전에서 깨어난 뒤 밀린 요청을 몰아서 보내지 않습니다.
지속 시간이 간격보다 짧으면 유지 요청을 보내지 않습니다. 페이지와 CLI 모두
`--interval` / `--max-ticks`를 지원합니다. 페이지의 `/cache-keeper DURATION` 명령은
현재 폼 설정을 사용합니다.

### TTL과 간격

활성화할 때 TTL을 고르거나 `--ttl DURATION`(예: `5m`, `1h`, `20m`, 최대 24h)을
지정하세요. 생략하면 Unknown으로 처리됩니다.

| TTL | 자동 간격 |
| --- | --- |
| Unknown | 3m |
| 5m | 3m |
| 1h | 50m |
| Custom | TTL의 5/6 |

직접 지정하는 간격은 선택한 TTL보다 짧아야 합니다. 요청 자체에 걸리는 시간과 지연
가능성을 감안하세요. TTL을 선택한다고 제공자의 캐시 유지가 보장되지는 않습니다.

### 토큰·비용 한도

토큰 한도와 달러 한도는 선택 사항이며, 현재 활성화 구간의 유지 요청에만 적용됩니다.
다시 명시적으로 활성화하면 초기화됩니다. 전체 토큰에는 모든 입력, 캐시 읽기/쓰기,
출력이 포함되며 제공자 필드를 중복 합산하지 않습니다. Claude 비용은 연속된 세션 비용의
차이로, Grok 비용은 요청별 추정치로 계산하고, Codex 비용은 **unknown**으로 남습니다
(달러 한도 지정 시 거부됨). runner를 연 뒤 첫 Claude 요청에는 비용 기준값이 없을 수
있으며, 달러 한도가 설정되어 있으면 유지가 일시 중지됩니다. 예산 사용량이 누락되거나
중단된 경우에도 일시 중지됩니다. 사용량 측정이나 응답 복구를 위한 추가 요청은 보내지 않습니다.

> [!IMPORTANT]
> **한도는 응답을 받은 뒤에 확인합니다. 요청 한 번으로 한도를 넘을 수 있습니다.**
> 한도에 도달하면 이후 유지 요청만 멈추며, 사용자의 실제 턴은 막지 않습니다.

시간 한도와 요청 횟수 한도는 계속 적용됩니다. 마지막 활성화의 설정과 측정 합계는 다시
열어도 유지되지만, 유지 기능 자체는 항상 꺼진 상태로 시작합니다. CLI 추정치는 구독
청구서가 아닙니다.

### 사용자 입력 우선

사용자 입력이 항상 우선합니다. 진행 중인 keeper 요청을 취소하고 종료가 확인된 뒤에
사용자에게 별도의 턴을 넘깁니다. **Turn off**는 일반 사용자 턴을 취소하지 않습니다.
인증 오류, 잘못된 응답, 예상치 못한 도구 호출, 프로토콜 오류, 판단하기 어려운 타임아웃이
발생하면 유지가 일시 중지됩니다. 교정용 모델 프롬프트나 즉시 재시도는 보내지 않습니다.

## 지원 경로

| 호스트 | 테스트 버전 | 관리 전송 방식 | 유지 요청 가드 |
| --- | --- | --- | --- |
| Claude Code | 2.1.282 | Structured print + resume | 번들된 PreToolUse deny 핸들러 |
| Codex | 0.156.1 | App Server thread/turn API | 번들된 전용 hook, 관리 세션에서 호스팅 웹 검색 비활성화 |
| Grok Build | 1.0.41 | Structured headless + resume | keeper 요청에 네이티브 `--deny '*'` 적용 |

세 호스트 모두 기존 구독 로그인으로 테스트했습니다. 모델은 각 CLI의 기본값을 그대로
사용하며, 유지 요청용 저가 모델이나 서브에이전트는 없습니다. 네이티브 세션을 관리 세션으로
넘기면 프롬프트 prefix가 바뀔 수 있습니다. headless 사용자 턴은 대화형 승인 요청을
거부하므로, 대화형 승인이 필요한 작업은 runner를 닫은 뒤 네이티브 클라이언트에서 하세요.
기존 호스트의 도구 규칙은 그대로 적용됩니다.

**완전한 숨김은 관리 페이지에서만 지원됩니다.** 네이티브 `/loop` 경로로는 이번 릴리스에
필요한 표시·전달 보장을 모두 확보할 수 없습니다. 그래서 `--require-native-loop`는 세
호스트 모두에서 활성화를 거부합니다. 원래 호스트의 화면에는 유지 턴이 보일 수 있습니다.
테스트된 한계는 [호환성 매트릭스](docs/compatibility-matrix.md)와
[검증 보고서](docs/validation-report.md)를 참고하세요.

## 개인정보와 제거

runner는 `127.0.0.1`에만 바인딩되며, 모든 세션 API 요청에 무작위 토큰을 요구합니다.
비공개 URL은 세션 접근 권한과 같으니 주의해서 다루세요. 렌더링되는 모델 출력은 텍스트이며,
실행 가능한 HTML로 처리되지 않습니다. Cache Keeper는 텔레메트리를 보내지 않습니다.

로컬 메타데이터는 `~/.cache-keeper`(또는 `CACHE_KEEPER_HOME`)에 저장됩니다. 세션 ID,
소유권 매핑, 설정, 횟수, 시각, 사용량을 저장하며, 대화 내용과 인증 정보는 호스트가
관리합니다. 메타데이터 파일 권한은 `0600`입니다.

제거하기 전에 Ctrl+C로 runner를 중지하세요. 호스트의 플러그인 제거 명령을 사용하고,
전역 설치했다면 `npm uninstall --global cache-keeper`도 실행하세요.
`cache-keeper forget --host HOST --session ID`는 중지된 세션의 keeper 메타데이터를
삭제합니다. 숨김 매핑도 함께 삭제되지만 원본 대화 기록은 건드리지 않습니다. 네이티브 예약
작업은 설치하거나 삭제하지 않습니다.

## 개발

```sh
npm test
npm run check
node tests/browser-reconnect.mjs  # Ego Lite, 로컬 가짜 호스트, 모델 사용 없음
npm run test:live -- --confirm-usage
# live 테스트를 한 계정으로 제한:
npm run test:live -- --confirm-usage codex
npm pack
```

오프라인 테스트는 마감 시간, 취소 순서, 큐잉, 오래된 콜백, 잠금, 표시 소유권, API 보안,
도구 가드를 다룹니다. `test:live` 스모크 테스트는 **호스트당 모델 턴 3회**를 사용한 뒤
같은 세션을 다시 엽니다. 통제된 유휴 테스트와 내구성 테스트는 지속 시간과 요청 한도를
별도로 명시하며, 명령은 검증 보고서에 있습니다. 모든 모델 테스트는 사용량 동의가 필요하고
인증 파일을 복사하지 않습니다. 보고서에는 사용량 요약만 담기며 인증 정보나 계정 식별자는
포함되지 않습니다.

런타임은 실행 가능한 ES 모듈 형태로 Node 표준 라이브러리만 사용합니다. 이번 릴리스에는
TypeScript 빌드 도구나 모노레포 의존성 그래프가 필요하지 않습니다. 릴리스 아카이브에는
테스트 스크립트와 정제된 측정 데이터가 포함되어 있어, 압축을 푼 사본에서도 검증 명령을
실행할 수 있습니다.

### 문서

- [문제 해결](docs/troubleshooting.md) · [개인정보](docs/privacy.md)
- [호환성 매트릭스](docs/compatibility-matrix.md)
- [최초 검증](docs/validation-report.md) · [심층 분석](docs/cache-analysis.md)
- [3개 호스트 후속 검증](docs/reproducibility-report.md) · [사용량 절감 연구](docs/usage-minimization.md)

과거 연구 문서는 당시 버전과 실험 설정을 그대로 유지합니다. 공통 단기 유휴 비교에서는
경제적 이점이 확인되지 않았고, 이전 Codex 캐시 이득에는 새로 추가된 지침을 워밍한 효과도
포함되어 있었습니다. 이 연구들은 0.2.0 UI나 예산 기능을 측정하지 않았습니다.

(문서는 영문으로 작성되어 있습니다.)

## 라이선스

[MIT](LICENSE)
