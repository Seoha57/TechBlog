---
layout: post
title: "테스트 병렬화와 샤딩을 설계하는 법: 격리·부하 균형·재시도로 CI를 빠르고 신뢰성 있게 만들기"
categories: [QA]
tags: [qa, testing, ci, parallelism, sharding, playwright, reliability]
description: "테스트 병렬화와 샤딩의 차이, 공유 상태를 격리하는 방법, 실행 시간 균형·리포트 병합·재시도 기준을 통해 CI 테스트를 안전하게 확장하는 설계를 설명합니다."
---

## 먼저 답하기

### Q. 테스트를 병렬로 돌리면 CI가 무조건 빨라지나요?

A. 아니다. 서로 독립적인 테스트가 충분하고 실행 환경·데이터·외부 의존성을 격리할 수 있을 때만 전체 완료 시간이 줄어든다. 테스트가 같은 계정, 같은 주문 번호, 같은 데이터베이스 레코드, 같은 파일 경로를 공유하면 병렬화는 단순한 속도 개선이 아니라 경쟁 조건을 추가하는 변경이 된다. 먼저 테스트가 어떤 상태를 공유하는지 분명히 하고, 그 다음 worker 수와 shard 수를 늘려야 한다.

### Q. 병렬화와 샤딩은 같은 말인가요?

A. 다르다. 병렬화(parallelism)는 한 실행 환경 안에서 여러 worker가 동시에 테스트를 수행하는 방식이다. 샤딩(sharding)은 전체 테스트 묶음을 여러 조각으로 나누어 여러 CI job 또는 여러 장비에서 독립적으로 실행하는 방식이다. Playwright 같은 도구는 한 job의 worker 병렬화와 `--shard=x/y` 형태의 분할 실행을 모두 지원한다. 두 방법을 같이 쓸 수 있지만, 각각의 CPU·브라우저·테스트 데이터·리포트 병합 비용을 따로 계산해야 한다.

## 먼저 알아둘 기반 기술

### 테스트 실행 시간은 왜 길어지는가

테스트 suite의 총 소요 시간은 모든 테스트 시간의 합만으로 결정되지 않는다. 브라우저 설치와 server boot, fixture 준비, database seed, 네트워크 대기, retry, 결과 업로드, 느린 테스트 하나가 마지막 shard를 붙잡는 꼬리 시간까지 포함된다. 예를 들어 테스트 100개가 평균 10초여도 한 파일에 20분짜리 시나리오가 몰려 있으면 파일 단위 샤딩은 한 worker만 오래 남길 수 있다.

그래서 목표는 "동시 실행 수를 최대화"가 아니라 CI의 wall-clock time, 즉 개발자가 결과를 기다리는 실제 시간을 줄이면서 실패 신호의 신뢰성을 유지하는 것이다. worker를 두 배로 늘렸는데 외부 테스트 환경의 rate limit과 DB lock이 늘어나 retry가 많아지면 오히려 더 늦고 불안정해질 수 있다.

### 프로세스, worker, shard

worker는 test runner가 동시에 실행하는 독립 프로세스 또는 실행 단위다. Playwright Test는 worker마다 독립 브라우저를 시작하고, 실패 뒤에는 다음 테스트를 깨끗한 환경에서 실행하도록 worker를 종료할 수 있다. 같은 worker 안의 파일은 재사용으로 빨라질 수 있지만, 전역 변수나 singleton state를 다른 worker와 공유할 수는 없다.

shard는 전체 suite의 일부다. `1/4`, `2/4`처럼 네 shard를 만들면 CI는 보통 네 개의 job을 실행한다. 각 job 안에서 worker를 다시 여러 개 쓸 수 있다. 따라서 실제 동시성은 `shard 수 × shard당 worker 수`에 가까워진다. 이 값은 CI runner 수, CPU, 브라우저 메모리, 테스트 대상 서버의 허용 부하보다 커지면 안 된다.

### 테스트 격리와 공유 상태

격리(isolation)는 한 테스트의 실행·실패·정리가 다른 테스트의 결과를 바꾸지 않도록 만드는 성질이다. 브라우저 쿠키와 local storage만 분리하면 충분하다고 생각하기 쉽지만, 실제 서비스 테스트에는 더 많은 공유 상태가 있다.

| 공유 대상 | 병렬 실행에서 생길 수 있는 문제 | 격리 방법의 예 |
| --- | --- | --- |
| 사용자 계정 | 비밀번호·프로필·권한을 서로 변경 | worker별 계정 또는 생성 후 폐기 |
| 데이터베이스 행 | 같은 주문·장바구니를 동시에 수정 | 고유 fixture ID, namespace, transaction cleanup |
| 파일·object storage | 동일한 이름을 업로드·삭제 | run ID가 포함된 경로 |
| 이메일·SMS sandbox | 다른 테스트의 메시지를 읽음 | 수신함·alias를 worker별로 분리 |
| 시간·배치 작업 | cron과 비동기 job이 순서를 흔듦 | fake clock, job queue 격리, polling 기준 |
| 외부 API | rate limit·실제 부작용 발생 | mock, sandbox tenant, 동시성 제한 |

격리는 테스트 코드의 `beforeEach` 한 줄로 끝나는 일이 아니다. 애플리케이션이 어떤 identifier를 생성하고, cleanup이 실패했을 때 무엇이 남으며, CI가 중단된 뒤 누가 이를 치우는지까지 포함한다. 테스트가 고유한 run ID를 갖도록 만들면 로그·trace·database row를 연결하기도 쉬워진다.

## 병렬화를 시작하기 전의 진단

### 1. 실행 시간을 측정 가능한 단위로 나눈다

먼저 최근 CI 실행의 테스트별·파일별 duration을 수집한다. 정확한 수치가 없으면 runner report, JUnit XML, Playwright blob report, CI job log에서 시작할 수 있다. 평균만 보지 말고 p95 또는 가장 느린 항목과 retry까지 본다. 평균 3초인 테스트 200개보다 8분짜리 테스트 하나가 shard 균형을 더 크게 좌우할 수 있다.

각 테스트에 다음 정보를 붙이면 병렬화 판단이 쉬워진다.

- 실행 시간과 retry 횟수
- browser·API·database·queue 중 사용 의존성
- 생성·수정하는 테스트 데이터 범위
- cleanup 방식과 실패 시 남는 리소스
- 순서를 요구하는지, 다른 테스트와 동시에 안전한지
- 실패했을 때 trace·screenshot·server log를 확보하는 방법

이 inventory가 없는데 shard 수만 늘리면, 실패가 늘어난 뒤 원인을 찾기 어려워진다. 특히 flaky test는 병렬화가 원인이 아니라 기존 격리 문제를 더 자주 드러낸 결과일 수 있다. 실패율을 먼저 숨기기 위해 retry를 늘리는 대신, 어떤 리소스가 공유됐는지를 조사한다.

### 2. 순서 의존 테스트를 발견한다

"A 테스트가 B보다 먼저 실행돼야 한다"는 문장은 대부분 테스트 데이터나 API 계약이 충분히 격리되지 않았다는 신호다. 예를 들어 가입 테스트가 공용 `demo@example.com` 계정을 만들고, 다음 테스트가 그 계정으로 로그인한다면 두 테스트는 독립 테스트가 아니라 하나의 긴 workflow다. 가능하면 각 테스트가 준비·실행·검증·정리를 스스로 하도록 바꾼다.

정말로 하나의 비즈니스 여정을 순서대로 검증해야 하는 경우도 있다. 이때는 전체 suite를 serial로 만들지 말고 해당 scenario만 별도 project 또는 tag로 묶고 worker를 제한한다. 다른 독립 테스트는 계속 병렬로 실행하게 해야 한다. serial group은 빠른 해결책처럼 보이지만 한 단계가 실패하면 이후의 실패 정보를 잃고 retry 범위도 넓어진다는 단점이 있다.

### 3. 테스트 대상 시스템의 허용량을 확인한다

CI runner가 16코어라고 해서 대상 API와 test database도 16배 요청을 처리할 수 있는 것은 아니다. 로그인 endpoint의 rate limit, shared staging database connection 수, email sandbox quota, Kubernetes namespace 생성 한도, third-party sandbox 정책을 확인한다. 테스트가 실제 결제 provider나 실사용자 알림을 건드릴 가능성이 있다면 병렬화 전에 sandbox와 권한 분리가 먼저다.

테스트 대상에 부하를 줄 수 있는 경로는 concurrency budget을 둔다. 예를 들어 browser UI test는 네 worker로, API contract test는 여덟 worker로, shared payment sandbox가 필요한 테스트는 한 worker로 나눌 수 있다. 같은 runner configuration에 모든 종류의 테스트를 넣으면 가장 제한적인 외부 의존성 때문에 전체 suite가 느려지거나, 가장 공격적인 테스트 때문에 외부 시스템이 불안정해질 수 있다.

## Playwright를 예시로 보는 병렬화와 샤딩

Playwright Test는 기본적으로 여러 test file을 병렬 worker에 배정하고, 하나의 file 안 테스트는 보통 순서대로 실행한다. `workers`는 한 job 안의 병렬 worker 수를 제한한다. CI와 local의 capacity가 다르므로 CI에서만 보수적인 값을 주는 구성이 흔하다.

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? 'blob' : 'html',
  use: {
    trace: 'retain-on-failure',
  },
});
```

이 예시는 네 worker가 항상 최적이라는 뜻이 아니다. worker 한 개가 browser, test server, fixture를 얼마나 쓰는지 보고 정해야 한다. memory 부족으로 브라우저가 죽으면 test failure처럼 보일 수 있고, job log에는 원인이 충분히 남지 않을 수 있다. 처음에는 작은 worker 수로 시작해 CI 대기 시간, runner CPU·memory, 대상 시스템 오류율, retry 비율을 함께 관찰한다.

여러 runner로 suite를 나누려면 shard를 지정한다.

```bash
npx playwright test --shard=1/4
npx playwright test --shard=2/4
npx playwright test --shard=3/4
npx playwright test --shard=4/4
```

각 명령은 서로 다른 CI job에서 실행해야 효과가 있다. 하나의 작은 runner에서 네 명령을 순서대로 실행하면 단지 관리 복잡도만 늘어난다. 또한 shard 수를 바꿀 때 report artifact 이름과 업로드 경로가 충돌하지 않는지 확인한다. 같은 `playwright-report` 디렉터리를 여러 job이 공유 object storage에 덮어쓰면, 최종 결과는 마지막 shard 하나만 남을 수 있다.

### 파일 단위와 테스트 단위 분할

Playwright는 `fullyParallel: true` 여부에 따라 shard를 나누는 단위가 달라질 수 있다. file 단위 분할은 한 파일 안 테스트가 같은 setup을 공유해야 할 때 단순하지만, 파일 크기가 제각각이면 shard 균형이 나빠질 수 있다. test 단위 분할은 더 고르게 나눌 가능성이 있지만, 각 테스트가 독립 setup·cleanup을 수행해야 하고 `beforeAll`에 의존한 공유 상태가 깨질 수 있다.

```ts
export default defineConfig({
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
});
```

설정을 켜기 전에 무작정 전체 suite에 적용하지 않는다. 독립적인 smoke test project에 먼저 적용하고, 한 파일의 테스트가 공용 계정·공용 cart·전역 feature flag를 공유하지 않는지 검토한다. 설정 값 하나가 테스트 실행 모델을 바꾸므로, 실패가 증가하면 먼저 `fullyParallel`을 끄는 rollback도 준비한다.

## 실행 시간 균형: 테스트 개수보다 duration이 중요하다

네 shard에 테스트 100개씩 나눴다고 해서 네 job이 동시에 끝나지는 않는다. 한 shard에 video upload, PDF rendering, 여러 locale을 도는 긴 흐름이 모이면 그 shard가 전체 pipeline을 붙잡는다. 처음에는 tool 기본 분할을 쓰되, 반복적으로 꼬리 시간이 큰 경우에는 duration history를 기준으로 태그·파일 구조·project를 조정한다.

다만 사람이 매번 "느린 테스트는 1번 shard"로 배치하는 방식은 오래 유지되기 어렵다. 테스트 시간이 release나 fixture에 따라 변하면 고정 배분은 곧 틀어진다. 가능한 경우 runner가 제공하는 test-level balancing을 쓰고, 그렇지 않다면 긴 E2E(end-to-end, 사용자 흐름을 처음부터 끝까지 검증하는 테스트)를 별도 suite로 분리해 그 suite만 더 긴 timeout과 낮은 concurrency를 갖게 한다.

균형을 판단할 때는 다음 세 시간을 분리한다.

| 시간 | 의미 | 개선 방향 |
| --- | --- | --- |
| queue time | CI runner를 기다린 시간 | shard를 무작정 늘리기 전 runner capacity 확인 |
| setup time | browser·server·fixture 준비 시간 | cache, reusable environment, test grouping 검토 |
| test execution time | 실제 assertion까지 걸린 시간 | 느린 경로·불필요한 UI 단계·데이터 접근 개선 |
| tail time | 마지막 shard만 남은 시간 | duration 균형, 파일 크기, shard 수 조정 |

테스트를 빠르게 하려는 목적이 실제 결함 탐지를 줄이는 일이 되면 안 된다. timeout을 줄여 실패를 빨리 만들거나 assertion을 없애는 것은 병렬화가 아니다. 성능 개선 뒤에도 핵심 workflow, browser·device 조합, 안전·권한 검증이 유지되는지 확인한다.

## 공유 상태를 없애는 구체적인 패턴

### worker별 테스트 사용자

각 worker가 `qa+run-20261116-w3@example.test` 같은 별도 사용자를 쓰도록 하면 프로필 수정·장바구니·권한 테스트가 서로 영향을 주는 일을 줄일 수 있다. 계정을 API로 미리 만들거나 fixture에서 만들 수 있다. 전자는 빠르지만 stale account 정리가 필요하고, 후자는 독립적이지만 setup 시간이 늘 수 있다. 어떤 방법이든 테스트 종료 뒤 cleanup이 실패했을 때 만료 정책으로 나중에 지울 수 있게 해야 한다.

### 고유한 비즈니스 키

주문 번호, coupon code, upload filename, tenant name에는 run ID와 test ID를 포함한다. timestamp만 쓰면 같은 millisecond에 시작한 worker가 충돌할 수 있고, 재시도 시 이전 리소스를 찾기 어렵다. random UUID를 쓰면 충돌 가능성은 낮지만 사람이 log에서 묶어 보기 어렵다. `ci-run-id + shard + worker + test-slug`처럼 검색 가능한 prefix와 유일 suffix를 함께 쓰는 식이 실용적이다.

### 외부 효과를 확인하고 되돌리기

email 전송, webhook, billing capture, queue publish 같은 외부 효과는 mock으로 대체할 수 있는지 먼저 본다. integration 확인이 꼭 필요하면 sandbox endpoint와 test-only credential을 사용하고, 실행 횟수 상한을 둔다. cleanup은 단순 삭제만이 아니라 실제로 취소·환불·queue drain 같은 보상 작업이 필요한지 검토한다. 병렬 테스트가 production-like sandbox를 오염시키면 다음 실행의 결과도 신뢰하기 어렵다.

## 리포트 병합과 실패 진단

shard마다 결과 report가 따로 생기므로, 최종 CI 결론은 모든 shard의 결과를 모은 뒤 내려야 한다. Playwright의 blob reporter는 shard별 결과와 첨부물을 모아 HTML report 등으로 병합하는 용도에 쓸 수 있다. shard 하나가 artifact upload에 실패했는데 나머지가 통과했다고 전체 build를 성공 처리하면, 누락된 테스트가 있는지 알 수 없다.

```bash
npx playwright merge-reports --reporter html ./all-blob-reports
```

병합 전에는 expected shard 수, 각 shard의 exit code, 발견한 test 수, skipped·failed·retried 수를 대조한다. result file이 있다고 해서 모든 테스트가 실행된 것은 아니다. 설정 오류로 한 shard가 0개 테스트를 실행하거나, filter가 일부 project를 제외했을 수 있다. CI summary에는 전체 test count와 shard별 count, 가장 느린 shard, retry한 테스트 목록을 남기면 다음 균형 조정의 근거가 된다.

실패 artifact도 test ID와 실행 ID로 찾을 수 있어야 한다. screenshot, trace, video, server log, browser console, network HAR 중 무엇을 실패 때 수집할지 정하고, 성공 실행마다 모든 파일을 영구 보관하지 않도록 보존 기간과 용량을 정한다. artifact가 너무 많아 runner 업로드가 느려지면 CI가 느린 원인이 테스트가 아니라 artifact 전송이 될 수 있다.

## 재시도는 신뢰성 보정이 아니라 진단 신호다

일시적인 네트워크 오류나 provider sandbox 장애는 retry가 도움이 될 수 있다. 그러나 test가 한 번 실패하고 두 번째에 통과했다고 해서 정상이라고 결론 내리면, flaky behavior를 main branch에 숨기게 된다. retry 결과는 다음처럼 분리해 보고한다.

- 첫 실행 통과: 안정 통과
- 첫 실행 실패 후 재시도 통과: flaky 후보
- 재시도도 실패: 재현 가능한 결함 또는 환경 장애 후보
- setup 실패: 테스트 assertion과 분리해 runner·dependency 문제로 분류

병렬화를 도입한 직후 flaky 후보가 늘었다면 retry 횟수부터 올리지 않는다. 같은 worker·shard·계정·namespace에 집중되는지, 특정 API rate limit 응답이 있는지, cleanup race가 있는지 확인한다. 좋은 retry 정책은 실패를 사라지게 하는 정책이 아니라, 일시 실패와 구조적 실패를 구분해 팀이 고칠 수 있게 하는 정책이다.

## 구체적인 업무 예시: 네 browser shard로 checkout 회귀 테스트 나누기

전자상거래 팀이 checkout E2E 240개를 매 pull request마다 실행한다고 하자. 초기에는 runner 한 대에서 worker 두 개를 써서 38분이 걸린다. 팀은 단순히 worker를 열여섯 개로 늘리는 대신 다음 순서로 설계한다.

1. 최근 20개 실행의 duration과 retry를 모아 checkout, promotion, payment, order history로 의존성을 분류한다.
2. 공용 `test-shopper` 계정을 없애고 worker별 고객·cart·address fixture를 만든다.
3. 실제 결제 호출은 sandbox card로 제한하고, payment provider가 허용하는 concurrency를 확인한다.
4. CI matrix로 네 shard를 만들되 shard당 worker는 두 개로 시작한다. 총 동시 browser는 여덟 개다.
5. blob report를 각 job artifact로 업로드하고, 병합 job이 네 결과 모두를 받지 못하면 pipeline을 실패시킨다.
6. 처음 일주일은 전체 시간뿐 아니라 payment API 오류, retry 후보, shard별 tail time을 보고 worker와 shard 수를 조절한다.

이 예시에서 성공 기준은 "38분이 10분이 됐다" 하나가 아니다. 각 shard가 비슷한 시간에 끝나고, test data가 남지 않으며, 실패한 test의 trace가 있고, 같은 commit을 다시 실행했을 때 결과가 예측 가능해야 한다. 속도는 그 결과로 따라온다.

## CI 구성에서 꼭 분리할 세 가지

### 빠른 검증, 넓은 회귀, 긴 시나리오

모든 테스트를 pull request 하나에 같은 우선순위로 넣으면, 느린 E2E가 개발자의 작은 수정 피드백까지 지연시킨다. 보통은 테스트를 중요도와 실행 비용으로 나누는 편이 낫다. lint와 unit test, 변경 영역의 API smoke test는 빠른 검증 단계에 둔다. browser·데이터베이스·여러 서비스가 필요한 회귀는 병렬 shard를 쓰되 merge 전에 끝나도록 한다. 외부 sandbox나 긴 batch가 필요한 시나리오는 nightly 또는 release 후보 단계로 분리할 수 있다.

이 분리는 테스트를 덜 한다는 뜻이 아니다. 어떤 결함을 어느 피드백 시간 안에 발견할지 명확히 하는 일이다. 예를 들어 로그인 화면의 필수 검증은 PR마다 몇 분 안에 알려야 하지만, 12개 locale에서 전체 checkout을 검증하는 일은 release 전까지 완료되면 될 수 있다. 분류 기준과 제외 기준을 문서화하면 테스트가 커져도 팀이 왜 특정 job이 merge gate인지 설명할 수 있다.

| 단계 | 주된 목적 | 병렬화 접근 | 실패 시 행동 |
| --- | --- | --- | --- |
| PR fast | 빠른 회귀 신호 | 낮은 worker, 작은 shard | 즉시 수정 또는 재현 |
| PR full | 주요 사용자 흐름 | 균형 잡힌 shard·artifact 병합 | trace로 원인 분류 |
| nightly | 넓은 조합·데이터 검증 | 시간 예산이 큰 별도 runner | flaky·환경 drift 조사 |
| release | 배포 후보 신뢰 확인 | production-like 제한 동시성 | release 보류·승인 판단 |

단계를 나눌 때 가장 위험한 실수는 full regression이 항상 실패해도 nightly 알림만 보내고 아무도 보지 않는 상태다. gate가 아닌 job이라도 owner, 실패 SLA, 재실행 기준을 가져야 한다. 병렬화로 빠른 신호를 만드는 것과 품질 책임을 분산시키는 것은 다른 문제다.

### matrix의 축을 필요 이상으로 늘리지 않는다

CI matrix는 browser, OS, locale, device, feature flag, shard를 곱해 쉽게 수백 job이 된다. 조합이 많아질수록 속도가 늦고 artifact 비용도 늘며, 같은 결함을 여러 번 보고할 수 있다. browser 호환성 확인이 목적이면 모든 business scenario를 모든 browser에서 반복하기보다, critical flow는 여러 browser로, 깊은 edge case는 대표 browser로 실행하는 식의 risk-based matrix가 더 실용적이다.

feature flag는 특히 조심한다. enabled와 disabled 경로를 모두 매 browser·locale·shard 조합에서 실행하면 조합 폭발이 난다. 중요한 flag interaction은 명시적 scenario로 두고, 나머지는 대표 환경에서 검사한다. 이것은 coverage를 포기하는 것이 아니라 결함 영향과 변경 가능성이 큰 조합에 예산을 쓰는 방법이다. 새 matrix 축을 추가할 때는 어떤 결함을 잡고, 얼마나 많은 runner 시간과 test data를 쓸지 먼저 적는다.

### cache와 재사용 환경의 경계

dependency 설치, browser download, container image build를 cache하면 setup 시간을 줄일 수 있다. 하지만 cache가 테스트 결과를 공유하게 해서는 안 된다. node module cache와 browser binary cache는 비교적 안전한 반면, 이전 실행의 database dump, 인증 token, browser profile, test result directory를 그대로 재사용하면 실행 간 오염이 생길 수 있다. cache key에는 lockfile·OS·browser version처럼 결과에 영향을 주는 요소를 포함하고, 테스트 데이터는 매 run에서 격리한다.

재사용하는 staging environment도 같은 기준으로 본다. deployment가 준비됐다는 health check, 이전 run의 background job이 끝났다는 확인, test namespace cleanup을 연결하지 않으면 병렬 job이 서로의 환경을 덮어쓴다. environment reuse는 시간을 줄여 주지만 ownership과 lifecycle을 명확히 할 때만 안전하다.

## 실패를 빠르게 좁히는 분류 방법

병렬 CI에서 실패한 test 이름만 보면 원인을 알기 어렵다. 같은 assertion failure가 product regression, 테스트 데이터 충돌, browser process crash, provider rate limit, runner disk 부족에서 모두 나올 수 있다. 첫 triage는 blame보다 분류가 우선이다. 다음 질문 순서가 도움이 된다.

1. 같은 commit을 독립 environment에서 다시 실행했을 때 같은 지점이 실패하는가?
2. 특정 shard·worker·browser·locale에서만 집중되는가?
3. assertion 전의 setup·fixture·login·외부 API 단계에서 이미 이상 신호가 있었는가?
4. trace와 server log의 request ID가 어느 run·어느 test data와 연결되는가?
5. 같은 시간대에 대상 sandbox 또는 CI runner의 자원 경고가 있었는가?

이 질문으로 product regression과 infrastructure failure를 완전히 자동 분류할 수는 없다. 그러나 재시도 버튼을 누르기 전에 필요한 증거를 모으게 한다. 매번 다른 worker에서만 실패한다면 code assertion보다 공유 환경 또는 resource contention을 먼저 의심할 수 있다. 반대로 같은 test가 여러 shard에서 같은 business assertion으로 실패한다면 실제 product change 가능성이 커진다.

### flaky budget을 둔다

flaky test를 수치로 관리하지 않으면 "가끔 실패하지만 다시 돌리면 된다"는 문화가 생긴다. suite별 first-attempt pass rate, retry pass count, 동일 test의 최근 실패 횟수, quarantined test 수를 dashboard에 남긴다. 팀이 정한 예산을 넘으면 새 테스트 추가보다 격리·cleanup·환경 안정화 작업을 우선할 수 있다. quarantine은 사용자에게 거짓 성공을 주지 않도록 별도 job에서 계속 실행하고, owner와 만료일을 둔다.

일시적으로 quarantine한 테스트를 완전히 skip해 버리면 결함 탐지 범위가 조용히 줄어든다. PR gate에서 뺄 필요가 있다면 nightly에서 지속 실행하고, issue에 재현 조건·artifact·제거 기준을 남긴다. 병렬화는 flaky test를 사라지게 하지 않으며, 때로는 그 문제를 더 자주 재현해 고칠 기회를 준다.

## worker 수를 조절하는 실험 절차

처음 설정은 추측이므로 작은 실험으로 검증한다. 같은 안정된 commit에서 worker 1, 2, 4처럼 한 번에 하나의 변수만 바꾸고, 각 경우를 여러 번 실행한다. 비교할 값은 전체 elapsed time뿐 아니라 setup time, 가장 느린 shard duration, retry 수, target API 오류, runner CPU·memory, artifact upload 시간이다. 한 번의 빠른 실행만 보고 결론 내리면 cache warm-up이나 외부 환경이 만든 우연을 설정으로 착각할 수 있다.

worker를 늘려도 tail time이 줄지 않는다면, 병렬성 부족이 아니라 긴 테스트 하나·파일 단위 불균형·공유 lock·외부 provider rate limit이 원인일 수 있다. 이 경우 shard를 더 늘리는 대신 해당 test를 분리하거나 test data 준비를 줄이는 것이 더 작은 해결책이다. 반대로 runner CPU가 놀고 있고 모든 shard가 비슷하게 끝나며 대상 시스템 오류도 없다면, 더 많은 worker를 제한된 범위에서 시험할 근거가 생긴다.

실험 결과는 config 파일 옆 또는 CI 문서에 짧게 남긴다. 왜 `workers: 4`인지, 어떤 테스트 그룹은 왜 하나로 제한했는지, 다음 재검토 조건이 무엇인지를 적으면 미래에 누군가 숫자만 크게 바꾸는 일을 줄일 수 있다. 이 기록은 성능 최적화 문서가 아니라 테스트 신뢰성의 설계 근거다.

## 병렬화 확대의 중단 기준

병렬 테스트를 늘리는 과정에는 "더 빠르면 계속 늘린다"가 아닌 중단 기준이 필요하다. 예를 들어 worker를 늘린 뒤 첫 시도 실패율이 기준보다 높아지거나, 외부 sandbox의 429·5xx가 급증하거나, runner memory 부족으로 browser가 종료되거나, cleanup backlog가 쌓이면 이전 안정 설정으로 되돌린다. 이 기준을 미리 적지 않으면 느려진 CI를 빨리 고치려는 압박 속에서 더 많은 concurrency를 추가하는 악순환이 생긴다.

설정 rollback은 config의 숫자를 원래대로 바꾸는 것만이 아니다. 새로 만든 matrix job, artifact 병합 경로, worker별 계정 pool, 환경 quota도 함께 되돌릴 수 있어야 한다. 변경 전 config와 마지막 안정 실행의 결과를 보관하고, 긴급 시 사용할 단일 worker·단일 shard 명령을 runbook에 둔다. 이 fallback은 느리지만 신뢰할 수 있는 기준선으로, 병렬화 도입 후 문제가 test code인지 인프라인지 구분하는 데도 도움이 된다.

병렬화가 필요한 이유는 개발자가 결과를 더 빨리 받고 품질 문제를 더 일찍 고치기 위해서다. 단축된 시간이 flaky 재실행·환경 정리·원인 불명 실패에 다시 쓰인다면 개선이 아니다. 속도, first-attempt reliability, 운영 비용, 디버깅 가능성을 함께 비교해 현재 suite에 맞는 가장 작은 동시성을 유지한다.

마지막으로 설정을 바꾼 pull request에는 대표 실행의 shard별 종료 시각, 실행된 test 수, retry 수를 남긴다. 다음 변경 담당자가 이전 결정의 근거를 보지 못하면, 같은 실험과 같은 장애를 반복하게 된다.

이력에는 runner 이미지와 browser version도 함께 남긴다. framework 또는 browser 업데이트 뒤의 성능·실패 변화는 shard 설정 문제처럼 보일 수 있으므로, 실행 환경의 변화를 구분할 수 있어야 한다.

이 기록을 변경 요청에 남기면, 성능 개선이 특정 날의 cache 상태나 우연한 외부 부하가 아니라 재현 가능한 설정 변경의 결과인지 다음 실행에서도 확인할 수 있다.

## 한계와 적용 기준 Q&A

## 병렬 테스트의 데이터 수명 관리

테스트 데이터는 생성과 cleanup 사이의 짧은 문제가 아니라, CI 중단·재시도·장애 조사까지 이어지는 수명 주기를 가진다. 어떤 run이 언제 어떤 tenant와 사용자를 만들었는지 모르면 cleanup job은 안전하게 지울 대상을 고르기 어렵다. 반대로 cleanup 범위를 넓게 잡으면 다른 실행 또는 사람이 쓰는 sandbox 데이터를 지울 위험이 있다. 모든 테스트 resource에 공통 prefix와 생성 시각, run ID, 소유 job을 넣고, cleanup은 그 prefix와 TTL(Time To Live, 생성 뒤 자동 만료까지의 시간)을 기준으로 제한한다.

예를 들어 test가 `qa-ci-<run-id>-<worker>-<slug>` 형태의 customer와 order를 만들었다면, 종료 hook은 해당 run ID 범위만 지운다. hook이 실행되지 않는 runner crash에 대비해 별도 janitor job이 만료된 prefix만 삭제할 수 있다. janitor는 실행 중인 run까지 지우지 않도록 현재 job registry 또는 충분한 유예 시간을 확인해야 한다. 이 설계는 cleanup code가 길어지는 이유가 아니라, 실패한 테스트를 다음 실행에서 재현 가능하게 만드는 기반이다.

### fixture의 범위를 명시한다

fixture는 test마다 새로 만드는지, worker마다 한 번 만드는지, shard마다 공유하는지, suite 전체에서 하나만 쓰는지를 명시해야 한다. test-scope fixture는 가장 격리되지만 setup 비용이 늘 수 있다. worker-scope fixture는 빠르지만 같은 worker의 테스트가 상태를 바꾸지 않는다는 계약이 필요하다. global fixture는 가장 빠를 수 있으나 병렬 실행에서 가장 위험하다. "setup이 느리다"는 이유로 global fixture를 선택하기 전에, browser navigation을 줄이거나 test API로 seed하거나 cache 가능한 dependency를 분리할 수 있는지 먼저 찾는다.

fixture 코드에는 생성한 리소스와 cleanup 실패를 log로 남긴다. cleanup 중 오류가 났는데 test assertion이 통과했다면 CI는 성공으로 보일 수 있다. 그러나 다음 실행에서 stale data가 충돌하면 원인을 찾기 어렵다. cleanup 실패는 별도 warning이 아니라 test infrastructure failure로 다루고, retry한다고 해결되는지와 수동 정리 runbook을 정한다.

## 설정 변경을 검증하는 작은 테스트

병렬화 설정은 application feature와 마찬가지로 regression을 만들 수 있다. CI config를 바꾼 뒤 다음 self-check를 둔다. 각 shard가 최소 한 개 이상 test를 발견하는가, 모든 shard report가 병합 입력에 도착하는가, test count 합이 단일 실행의 count와 같은가, intentional failure를 넣은 branch에서 전체 job이 실패하는가를 확인한다. 이 검증은 test framework 자체를 신뢰하지 못해서가 아니라, matrix 변수·path filter·artifact name 같은 glue 설정 오류를 빠르게 잡기 위해서다.

간단한 smoke suite를 의도적으로 여러 file에 나누고, 고유 marker를 가진 test가 어느 shard에서 실행되는지 CI log에 남기면 shard 설정 변경을 검증할 수 있다. report merge job은 artifact가 하나라도 없을 때 경고만 내고 성공하지 않도록 한다. 테스트를 빠르게 만들려다 일부 파일을 실행하지 않는 실패는 가장 위험한 종류의 "성공"이다.

## 팀 합의가 필요한 지점

병렬 CI는 QA 팀만의 설정이 아니다. 개발자는 test data contract와 cleanup을 지키고, platform 팀은 runner·sandbox quota를 제공하며, SRE 또는 infrastructure 담당자는 대상 환경의 부하 경계와 관찰성을 제공한다. release manager는 어떤 suite가 merge gate인지, 어떤 실패가 재실행 가능한지 정한다. 이 역할이 불분명하면 flaky test가 나올 때마다 QA는 환경 탓, 개발은 test 탓, platform은 runner 탓을 하게 된다.

최소한 다음을 문서로 합의한다. 각 suite의 owner, 테스트 환경 소유자, 외부 sandbox 책임자, artifact 보존 기간, flaky escalation 기준, CI capacity 증설 승인자다. 기술적으로 worker 하나를 추가하는 변경도 비용·외부 API 사용량·shared environment에 영향을 줄 수 있으므로, 운영 기준을 코드와 같이 관리한다.

### Q. 모든 테스트를 `fullyParallel`로 켜면 가장 좋은가요?

A. 아니다. test-level 병렬화는 균형에는 유리할 수 있지만 각 테스트가 완전히 독립적이어야 한다. `beforeAll`에서 만든 공유 데이터, 같은 계정, 순서 의존 workflow가 있으면 실패할 수 있다. 독립 smoke test부터 적용해 영향과 artifact를 확인한 뒤 확대한다. 격리할 수 없는 legacy scenario는 좁게 serial로 두고 개선 목록으로 관리하는 편이 안전하다.

### Q. shard 수를 두 배로 하면 CI 시간이 반으로 줄어드나요?

A. 보장되지 않는다. setup, runner queue, 가장 느린 shard, 외부 API rate limit, artifact upload, 테스트 간 lock이 남아 있기 때문이다. 먼저 shard별 duration과 tail time을 보고, 현재 runner와 대상 시스템이 더 많은 동시성을 감당하는지 확인한다. 비용과 실패율까지 함께 비교해야 한다.

### Q. flaky test는 retry가 통과하면 닫아도 되나요?

A. 안 된다. retry 통과는 재현이 항상 되는 결함보다 조사하기 어렵다는 신호일 수 있다. first-attempt failure를 별도 지표로 남기고, trace·로그·공유 데이터·환경 부하를 확인한다. 팀이 정한 기간 동안 같은 test가 반복 재시도되면 격리·대기·mock·product code 중 어느 층을 고칠지 결정한다.

### Q. 테스트 환경이 하나뿐인데 병렬화할 수 있나요?

A. 가능할 수도 있지만 조건이 엄격하다. namespace, tenant, database schema, 계정, 파일 경로를 확실히 분리하고 외부 의존성의 concurrency 한도를 지켜야 한다. 이것이 불가능하면 해당 환경을 쓰는 테스트는 worker 수를 제한하거나 serial project로 분리한다. 환경 하나를 공유한다는 사실을 숨기고 병렬화를 켜는 것이 가장 위험하다.

## 배포 전 점검 목록

- 테스트별 duration·retry·외부 의존성을 수집했는가?
- worker와 shard의 곱이 runner·browser·대상 시스템의 동시성 한도 안에 있는가?
- 계정, 데이터, 파일, queue, feature flag를 test 또는 worker별로 격리했는가?
- cleanup 실패 뒤 남은 데이터를 만료시키는 방법이 있는가?
- serial이 필요한 scenario만 좁게 분리했는가?
- shard report와 artifact 이름이 충돌하지 않고 모든 shard 결과를 병합하는가?
- retry 결과를 안정 통과와 별도로 flaky 후보로 집계하는가?
- shard 증가 전후의 queue time·tail time·오류율·비용을 비교하는가?

## 마무리

테스트 병렬화와 샤딩은 CI 시간을 줄이는 강력한 도구지만, 테스트의 독립성을 대신 만들어 주지는 않는다. worker를 늘리기 전에 공유 상태와 외부 의존성을 찾아 격리하고, shard를 늘리기 전에 실행 시간 분포와 대상 시스템의 부하 한도를 확인해야 한다. 리포트 병합과 실패 artifact까지 설계해야 빠른 CI가 디버깅 가능한 CI가 된다.

처음에는 독립적인 smoke 또는 API suite에서 작은 worker 수와 두 개 shard로 시작하자. 결과를 test count, tail time, retry, 외부 오류로 나눠 관찰하고, 문제가 보이면 concurrency를 더 올리기보다 격리와 cleanup을 먼저 고친다. 신뢰할 수 있는 병렬 테스트는 많은 runner를 쓰는 기술이 아니라, 각 테스트가 혼자 실행돼도 같은 의미를 갖게 만드는 품질 설계다.

<h3 class="references-heading">참고 자료</h3>

- [Playwright: Parallelism](https://playwright.dev/docs/test-parallel)
- [Playwright: Sharding](https://playwright.dev/docs/test-sharding)
- [Playwright: Test isolation](https://playwright.dev/docs/browser-contexts)
- [Google SRE Book: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- [Martin Fowler: Eradicating Non-Determinism in Tests](https://martinfowler.com/articles/nonDeterminism.html)
