---
layout: post
title: "기능 플래그 테스트를 설계하는 법: 조합 폭발·점진 배포·정리까지"
categories: [QA]
tags: [qa, feature-flag, testing, rollout, release, quality]
description: "기능 플래그가 만드는 실행 경로를 테스트하기 위해 대상 조합을 고르고, 점진 배포·관찰·정리까지 연결하는 방법을 설명합니다."
---

## 먼저 답하기

### Q. 기능 플래그를 쓰면 테스트 없이 안전하게 배포할 수 있나요?

A. 아닙니다. 기능 플래그(feature flag)는 코드를 즉시 모든 사용자에게 켜지 않고 조건에 따라 활성화하는 제어 장치다. 위험을 줄일 수 있지만, 같은 binary 안에 여러 실행 경로를 만들기 때문에 테스트해야 할 상태가 늘어난다. 플래그가 꺼진 기존 경로와 켜진 새 경로, 대상 사용자 조건, 되돌림 동작을 검증해야 안전하다.

### Q. 모든 플래그 조합을 테스트해야 하나요?

A. 보통은 불가능하고 필요하지도 않다. 플래그의 목적·영향 범위·상호작용을 기준으로 고위험 조합을 고른다. 결제·권한·데이터 migration처럼 실패 영향이 큰 기능은 더 넓게 확인하고, 화면 문구처럼 독립적인 플래그는 대표 경로를 중심으로 확인한다. 중요한 것은 조합 수를 세는 것이 아니라 어떤 조합을 왜 제외했는지 설명하는 것이다.

## 먼저 알아둘 기반 기술

### 기능 플래그와 설정 값의 차이

기능 플래그는 새 기능의 실행 여부 또는 대상 사용자를 제어하는 boolean·percentage·attribute rule이다. 예를 들어 `new_checkout=true`면 새 결제 화면을, false면 기존 화면을 사용하게 할 수 있다. 설정 값(configuration)은 timeout, URL, 임계값처럼 같은 기능의 동작 파라미터를 바꾸는 데 쓰일 수 있다. 둘은 구현상 같은 key-value 저장소에 있어도 수명과 검증 방식이 다르다. 기능 플래그는 보통 출시 뒤 제거할 임시 분기이고, 설정 값은 장기간 유지될 수 있다.

### deployment와 release

deployment는 code를 실행 환경에 올리는 일이고, release는 사용자가 새 동작을 실제로 쓰게 하는 일이다. 플래그는 둘을 분리한다. 배포된 code가 있어도 플래그를 끄면 기능은 노출되지 않을 수 있고, 같은 배포본에서 일부 tenant에게만 켤 수 있다. 이 분리가 rollback 속도를 높일 수 있지만, 오래된 code path가 계속 실행되는 비용도 만든다.

### 관찰성과 guardrail

점진 배포에는 기능별 성공률·오류율·latency·업무 지표 같은 관찰이 필요하다. guardrail은 정해진 오류율이나 결제 실패율처럼 넘으면 rollout을 중지하거나 플래그를 끌 기준이다. 단순히 플래그를 켰다는 이벤트만 보지 말고, 대상 집단과 대조 집단의 결과가 어떤지, 데이터가 충분한지, 외부 요인이 있는지를 함께 본다.

## 플래그가 필요한 이유와 새로운 위험

큰 변경을 한 번에 모든 사용자에게 공개하면 오류가 생겼을 때 영향 범위가 크다. 플래그는 내부 직원, 특정 tenant, 1% 사용자처럼 작은 집단에서 기능을 확인하고 점진적으로 넓히게 한다. 긴급 상황에는 새 binary를 다시 배포하지 않고 플래그를 꺼서 노출을 줄일 수 있다. A/B 실험, migration 전환, 외부 provider 교체에도 쓰일 수 있다.

그러나 플래그가 늘면 code가 `if` 문으로 갈라지고, 서로 다른 사용자에게 다른 상태가 보이며, support가 문제를 재현하기 어려워진다. 꺼진 경로가 오래 남아 security patch와 data schema 변경을 놓칠 수 있다. default 값과 fallback을 모르면 outage에서 잘못된 경로가 열릴 수 있다. 플래그는 릴리스 도구이지 공짜 안전 장치가 아니다.

## 플래그를 분류해 테스트 범위를 정하기

먼저 플래그마다 목적과 종료 조건을 기록한다. release flag는 새 기능을 점진 공개한 뒤 제거할 대상이고, experiment flag는 두 경험을 비교하기 위한 대상이며, operations flag는 장애 시 feature를 끄기 위한 kill switch일 수 있다. permission flag는 특정 고객 계약이나 역할에 따라 장기간 유지될 수 있다. 같은 "flag"라도 제거 시점과 테스트 우선순위가 다르다.

영향도를 평가할 때는 데이터 쓰기, 인증·권한, 금전, 외부 provider, 되돌릴 수 없는 migration, 공통 library 사용 여부를 본다. 새 추천 카드의 색상은 UI regression 중심으로 볼 수 있지만, 새 할인 계산은 기존·신규 계산 결과, idempotency, 결제 실패, rollback 뒤 주문 상태까지 확인해야 한다. 이 분류를 backlog와 test plan에 연결하면 테스트가 막연한 조합 나열이 되지 않는다.

## 조합 폭발을 다루는 방법

플래그가 세 개면 on/off 조합은 여덟 개이고, 열 개면 1,024개다. 실제로는 일부 조합이 동시에 켜질 수 없거나 서로 독립적이며, 일부는 특정 tenant에서만 적용된다. 먼저 의존 그래프를 그려 "A가 켜지면 B가 항상 켜져야 하는가", "A와 C가 동시에 켜지면 데이터 형식이 달라지는가"를 찾는다. 상호작용이 없는 플래그를 모든 조합으로 테스트하는 시간보다, 상호작용이 있는 경계에 집중하는 편이 낫다.

pairwise testing은 두 플래그 값의 모든 쌍을 대표 조합으로 덮으려는 기법이다. 유용한 출발점이 될 수 있지만 결제 승인·권한 우회처럼 세 조건이 함께 있어야 실패하는 경우를 보장하지 않는다. 고위험 규칙은 pairwise에 맡기지 말고 명시적인 scenario를 만든다. 예를 들어 `new_pricing`, `coupon_migration`, `admin_override`가 함께 켜진 관리자 주문은 별도의 테스트 케이스로 둔다.

플래그 default도 조합의 일부다. flag service가 timeout되거나 cache가 비었을 때 false로 fail closed할지, 기존 동작을 유지할지, 요청을 거절할지를 기능별로 결정한다. 이 failure mode는 network error와 provider outage를 포함한 integration test에서 확인한다. 정상적으로 flag를 가져오는 테스트만 하면 실제 장애에서의 행동을 알 수 없다.

## 업무 예시: 새 할인 계산 기능

새 할인 엔진을 도입하면서 `discount_v2` 플래그로 일부 사용자에게만 새 계산을 보여 준다고 하자. 테스트는 단순히 플래그 on에서 할인이 계산되는지만 보지 않는다. 플래그 off의 기존 금액이 유지되는지, on 대상 선정이 tenant·사용자 ID 정책과 맞는지, 장바구니에서 결제까지 같은 계산 revision을 쓰는지, 새 엔진 오류 시 어떤 fallback을 쓰는지를 확인한다. 이미 결제한 주문을 조회할 때 현재 플래그 값이 바뀌어 과거 금액이 달라 보이지 않아야 한다.

canary 대상에서 주문 생성·취소·환불·쿠폰 중복 적용·재시도 같은 대표 흐름을 만들고, 주문 record에 어떤 pricing version이 적용됐는지 남긴다. 오류가 나면 kill switch를 끄는 것만으로 충분한지, 진행 중인 transaction은 어떻게 되는지, 이미 생성한 주문을 보정해야 하는지를 runbook에 적는다. 이 예시는 특정 운영 경험이 아니라 플래그 테스트가 확인해야 할 업무 경계를 보여 주기 위한 것이다.

## 테스트 층을 나누기

단위 테스트에서는 flag evaluator에 주어진 user attribute와 default에서 기대한 variation이 선택되는지 확인한다. business logic 테스트에서는 flag on/off가 규칙과 계산 결과를 어떻게 바꾸는지 확인한다. API·UI 통합 테스트에서는 client와 server가 같은 flag context를 해석하는지, cache 때문에 오래된 값이 남지 않는지, 권한 없는 사용자가 내부 variation을 선택하지 못하는지 본다. E2E는 중요한 사용자 경로에서 실제 화면과 backend 상태가 일치하는지 확인한다.

테스트 fixture는 flag 값을 전역으로 변경한 뒤 다음 테스트에 남기지 않도록 격리한다. 병렬 test가 같은 remote flag environment를 공유하면 한 test의 on 상태가 다른 test를 깨뜨릴 수 있다. 가능하면 evaluator를 dependency로 주입하거나 request-scoped context를 사용하고, remote provider를 쓰는 integration test는 고유한 project·environment·key로 분리한다. cleanup 실패는 flaky test의 흔한 원인이다.

## 점진 rollout과 관찰

rollout은 1%, 5%, 25%처럼 숫자를 올리는 의식이 아니라 각 단계에서 확인할 가설을 검증하는 과정이다. 대상 조건, 시작·종료 시각, 확인 지표, guardrail, 다음 단계 승인자를 적는다. 새 checkout이라면 페이지 오류율뿐 아니라 주문 완료율, 결제 승인 실패, support contact, latency를 본다. 대조군과 대상군의 고객 유형이 달라 결과를 잘못 해석하지 않도록 selection rule도 남긴다.

관찰 지표는 개인 식별자를 포함하지 않는 집계로 남긴다. request ID, flag revision, variation, 오류 종류, latency 같은 metadata는 원인 분석에 도움이 된다. 그러나 variation 이름에 고객 정보를 넣거나 debug log에 전체 user profile을 넣으면 플래그 도구가 개인정보 저장소가 될 수 있다. 관찰성의 목적은 대상 사용자를 추적하는 것이 아니라 release 위험을 판단하는 것이다.

## rollback과 데이터 호환성

플래그를 끄는 rollback은 code rollback보다 빠를 수 있지만, 새 경로가 database schema나 message 형식을 이미 바꿨다면 단순하지 않다. 새 writer가 만든 record를 기존 reader가 읽을 수 있는지, 새 field가 없어도 기존 code가 동작하는지, migration이 backward compatible한지 먼저 확인한다. flag로 감싼 destructive schema change는 쉽게 되돌릴 수 없으므로 expand-and-contract처럼 호환 기간을 두는 migration 전략이 필요하다.

rollback 조건도 구체적으로 정한다. "오류가 많으면 끈다" 대신 어떤 오류율·어떤 업무 지표·어떤 기간에서 중지할지, 누가 kill switch를 실행하는지, 중지 뒤 어떤 데이터 검증을 하는지 적는다. 보안 incident라면 기능을 끄는 것보다 접근 token 폐기나 특정 tenant 차단이 우선일 수 있다. 플래그는 판단을 대신하지 않고, 정한 판단을 빠르게 실행하게 하는 장치다.

## 플래그 정리와 기술 부채

release가 안정된 뒤 플래그를 남겨 두면 미래의 테스트·리뷰·보안 점검 비용이 계속 늘어난다. 각 flag에는 owner, 생성일, 목적, default, 종료 예정일, 사용 위치를 남기고 정기적으로 오래된 항목을 찾는다. 제거 작업은 production default를 확정하고, 꺼진 경로·테스트 fixture·문서·dashboard·alert를 함께 삭제하는 change다. flag key만 지우고 code 분기를 남기면 debt는 줄지 않는다.

제거 전에는 아직 어떤 client나 job이 옛 variation을 요구하지 않는지, analytics가 해당 key를 참조하지 않는지, rollback window가 끝났는지 확인한다. 실험 결과를 보존해야 한다면 raw flag가 아니라 필요한 집계와 결정 기록만 남긴다. 완성된 rollout의 가장 좋은 결과는 영구적인 flag가 아니라 단순해진 code path다.

## flag 평가가 일관되게 동작하는지 확인하기

플래그 시스템은 보통 사용자 ID, tenant, 국가, 앱 버전, role, 요청 header 같은 attribute를 받아 variation을 결정한다. 이때 같은 사용자가 웹과 모바일에서 다른 variation을 받거나, 익명 사용자에게 특정 tenant 규칙이 적용되면 재현과 분석이 어려워진다. evaluator 입력을 정규화하고, 어떤 attribute가 없을 때 default를 쓰는지 명시하며, server·client SDK가 같은 규칙 version을 쓰는지 테스트한다. attribute 자체에 이메일이나 전화번호 같은 원문 개인정보를 넣지 않고 내부 식별자와 최소 metadata를 사용한다.

percentage rollout은 hash와 bucketing 규칙에 의존한다. 같은 사용자에게 요청마다 on/off가 바뀌면 장바구니·결제처럼 상태가 있는 기능에서 오류가 생길 수 있다. stable key가 무엇인지, user가 로그아웃했을 때 anonymous key와 어떻게 이어지는지, hash salt를 바꾸면 대상이 어떻게 달라지는지 확인한다. 테스트는 0%, 1%, 50%, 100%뿐 아니라 attribute 누락·잘못된 형식·SDK 초기화 실패·local cache 만료 같은 경계를 포함해야 한다.

## 플래그 provider 장애와 offline 동작

remote flag provider를 호출하는 application은 network timeout, DNS 실패, 인증서 오류, rate limit, 잘못된 SDK key를 만날 수 있다. 이때 request마다 provider를 기다리면 feature 문제가 전체 서비스 latency로 번질 수 있다. SDK의 cache, bootstrap configuration, refresh interval, timeout, 마지막 알려진 값 사용 정책을 기능 위험도에 맞춰 정한다. 새 기능을 기본 off로 두는 release flag는 provider 장애에서 off로 돌아가도 안전할 수 있지만, 이미 고객 계약으로 제공 중인 permission flag는 다른 대응이 필요할 수 있다.

offline fallback을 테스트할 때는 provider가 응답하지 않는 상황만 만들지 말고, 오래된 cache가 남은 상황과 새 revision을 아직 받지 못한 Pod를 함께 본다. cache의 값이 배포본과 호환되는지, rollout 중 일부 instance만 새 rule을 보는지, 장애가 끝난 뒤 최신 값으로 수렴하는지 확인한다. cache 파일이나 환경 변수에 민감한 targeting data가 남는다면 접근 권한과 보존도 점검한다.

## API, UI, batch가 서로 다른 flag를 읽는 문제

한 기능은 browser UI, backend API, background worker, scheduler, webhook consumer가 함께 처리할 수 있다. UI만 `new_refund_flow`를 on으로 보고 backend가 off로 보면 사용자는 새 버튼을 누르지만 서버는 기존 payload를 기대할 수 있다. 반대로 worker가 새 message format을 쓰는데 consumer가 off 상태면 queue가 쌓일 수 있다. flag evaluation 위치를 정하고, request에 결과를 전달할지 각 component가 독립적으로 평가할지 선택한다.

독립 평가를 택한다면 같은 context와 revision으로 같은 결론이 나오는지 contract test를 둔다. 결과를 request header에 넣는 방식은 client가 값을 조작할 수 있으므로 server가 신뢰하면 안 된다. backend가 권한·업무 규칙을 최종 판단하고, UI flag는 화면 경험을 제어하는 수준으로 제한하는 편이 안전하다. batch와 scheduled job은 사용자 context가 없으므로 default와 service identity를 명확히 지정한다.

## 데이터 migration과 flag의 순서

새 기능이 새 column이나 table을 쓰면 schema migration과 flag rollout 순서가 중요하다. 먼저 기존 application도 읽을 수 있는 schema를 추가하고, 새 code를 배포한 뒤 flag로 새 writer를 좁게 켠다. 새 형식으로 쓴 data를 기존 reader가 처리할 수 있는지 확인하고, 모든 reader가 새 형식을 이해한 뒤에야 오래된 column과 분기를 제거한다. 이른 삭제는 flag를 끄더라도 rollback할 수 없는 상태를 만든다.

database backfill도 같은 원칙이다. background job이 과거 record를 새 형식으로 바꾸는 동안 새·구 경로가 모두 읽을 수 있어야 하며, job을 재시작해도 중복 처리나 손상이 없어야 한다. test 환경에서 작은 sample만 보지 말고 null, 오래된 record, 부분 실패, 재시도, 순서가 다른 이벤트를 포함한다. migration 완료 지표와 flag 제거 조건을 연결하면 "코드는 켜졌지만 data가 준비되지 않음"을 줄일 수 있다.

## QA가 남겨야 할 테스트 매트릭스

테스트 매트릭스는 모든 조합을 표로 늘어놓는 문서가 아니라 위험 판단의 근거다. 행에는 플래그와 variation, 열에는 사용자 역할·데이터 상태·외부 의존성·실패 모드를 둔다. 고위험 교차점에는 명시적 scenario와 기대 결과를 쓰고, 독립적인 플래그는 대표 테스트만 선택한 이유를 남긴다. default, provider timeout, cache stale, rollback 중 상태처럼 평소 UI에서 잘 보이지 않는 경우도 행으로 넣는다.

매트릭스가 너무 커지면 자동화가 아닌 의사결정부터 줄인다. 장기 permission flag와 단기 release flag를 분리하고, 이미 제거 예정인 experiment의 범위를 넓히지 않으며, 한 release에서 서로 의존하는 flag 수를 제한한다. 플래그 수가 많다는 사실은 테스트 팀의 노력으로만 해결할 문제가 아니라 제품과 배포 설계의 복잡도 신호다.

## 관찰 결과를 다음 release에 쓰기

rollout 중 5xx가 늘었다면 단순히 flag를 끄고 끝내지 않는다. variation, application revision, region, tenant segment, provider 상태, 최근 migration을 연결해 원인을 좁힌다. 오류가 특정 대상에서만 보이면 targeting rule이 잘못됐을 수 있고, 모든 대상에서 보이면 새 code 자체의 결함일 수 있다. 지표가 정상이어도 support 문의와 업무 데이터의 이상을 함께 봐야 한다. 작은 대상이라 통계적 신호가 약한 경우에는 사람이 확인할 수 있는 sample과 feedback channel을 둔다.

release가 끝난 뒤에는 어떤 가설이 맞았고 guardrail이 유효했는지 기록한다. 이 기록은 다음 플래그의 rollout 비율·관찰 기간·테스트 우선순위를 정하는 자료가 된다. 개인 사용자의 세부 행동을 과도하게 기록하기보다, 기능·variation·집계 결과·결정 시각·남은 위험을 남기는 방식이 privacy와 운영성을 함께 지킨다.

## 접근 제어와 대상 선정 검증

permission flag는 단순한 UI 숨김으로 구현하면 안 된다. 관리자가 아닌 사용자가 URL을 직접 호출하거나 API body를 조작했을 때도 server가 권한을 다시 확인해야 한다. 플래그 evaluator가 `admin_tools=true`를 반환했다는 사실은 화면을 열 조건일 뿐, database export·권한 변경·고객 데이터 조회를 허용하는 근거가 아니다. authorization은 backend의 정책과 identity에서 결정하고, 플래그는 이미 허용된 기능의 출시·경험 범위를 조절하는 역할로 둔다.

tenant rollout도 테스트 대상이다. 계약 고객에게만 열 기능에서 tenant ID mapping이 잘못되면 다른 고객이 기능을 보거나 대상 고객이 막힐 수 있다. production tenant 이름을 test fixture에 쓰기보다 synthetic tenant와 권한 fixture를 만들고, allowlist·denylist·percentage rule·attribute 누락을 각각 확인한다. 대상 규칙을 수정한 사람이 왜 특정 집단을 포함·제외했는지 기록하면 support와 security review가 쉬워진다.

## 플래그 값의 변경 이력과 감사

운영자가 console에서 flag를 바꾸는 순간은 배포와 비슷한 영향이 있을 수 있다. 누가 어느 environment에서 어떤 default·target rule을 언제 바꿨는지, 변경 전후 값과 승인 근거를 audit trail로 남긴다. 특히 kill switch를 켜거나 100% rollout을 하는 작업은 한 명의 실수로 큰 영향을 낼 수 있으므로 역할 분리와 승인·알림을 검토한다. audit log에는 사용자 이메일이나 전체 targeting attribute를 불필요하게 넣지 않는다.

변경 이력은 사고 조사뿐 아니라 테스트 기준에도 쓰인다. 1% rollout을 시작한 시각과 application release SHA를 연결하면 오류 증가가 새 code인지 flag rule인지 구분할 수 있다. rollback 뒤에는 어떤 variation이 어느 요청에 적용됐는지 완벽하게 재현하지 못할 수 있으므로, 집계 지표와 변경 시각·revision을 남기는 것이 중요하다. 로그 보존 기간과 접근 권한도 다른 운영 로그와 같은 기준으로 관리한다.

## 다중 지역과 시간대의 차이

여러 region에 배포한 서비스는 flag 값이 전파되는 순서와 cache 갱신 시점이 다를 수 있다. 한 region에서 새 event format을 발행하고 다른 region의 consumer가 아직 이전 format을 기대하면 queue processing 오류가 생길 수 있다. global flag를 쓸 때는 region별 rollout 완료 기준, cross-region 의존성, disaster failover 중 어떤 flag configuration을 사용할지 적는다. 시간대 기준의 프로모션·마감 기능은 server timezone과 고객 timezone을 혼동하지 않도록 테스트한다.

region별로 flag를 나누는 것이 항상 정답은 아니다. 규칙이 많아질수록 운영자가 어떤 조합이 실제인지 이해하기 어려워진다. 필요한 분리만 두고, region independent한 기능은 같은 revision과 default를 공유한다. 테스트 매트릭스에도 최소 한 지역에서의 provider outage와 다른 지역의 정상 상태를 포함하면 전파 지연의 위험을 일찍 볼 수 있다.

## 외부 의존성 교체에 쓰는 플래그

새 payment provider, search engine, email service로 전환할 때 flag는 request를 일부만 새 provider로 보내는 데 유용하다. 그러나 읽기 요청과 쓰기 요청의 consistency, retry, idempotency, callback format, 비용·quota가 다를 수 있으므로 단순 비율 rollout만으로는 부족하다. 같은 주문의 retry가 이전 provider와 새 provider로 분산되지 않게 stable routing key를 정하고, provider 장애 시 어느 쪽으로 fallback할지 정한다.

QA는 성공 응답만 비교하지 말고 timeout, 4xx·5xx, 중복 callback, 부분 승인, provider 별 validation 차이를 확인한다. 새 provider가 만든 data를 이전 provider 경로가 이해할 수 있는지, 전환을 되돌렸을 때 이미 생성한 resource를 어떤 화면에서 보여 줄지도 검증한다. flag가 있는 이유는 두 provider를 영구히 유지하기 위함이 아니라 안전하게 전환하고 불필요한 경로를 제거하기 위함이다.

## 플래그와 테스트 데이터의 관계

flag on 상태를 검증하려면 특정 user attribute나 database 상태가 필요할 수 있다. test가 shared staging의 실제 고객과 비슷한 ID를 사용하면 잘못된 targeting rule에 걸릴 수 있으므로, 테스트 전용 tenant·user·coupon·order를 만들고 lifecycle을 관리한다. test가 끝난 뒤 만든 data와 flag override를 cleanup하지 않으면 다음 테스트 또는 사람이 보는 staging 화면에 영향을 준다.

data setup은 test의 일부로 version 관리한다. 어떤 scenario가 어떤 flag variation, 어떤 schema revision, 어떤 user role에서 실행됐는지 기록하면 failure를 재현할 수 있다. fixture가 너무 복잡해지면 behavior를 검증하는 대신 환경을 만드는 데만 시간이 쓰이므로, scenario별 최소 data를 유지하고 공통 setup은 신중하게 재사용한다. 플래그가 늘어나는 속도보다 test fixture가 복잡해지면 제품 설계를 다시 단순화할 신호다.

## 고객 지원과 재현 절차

기능 플래그 때문에 고객마다 다른 경험을 할 수 있으므로 support가 문제를 조사할 때 필요한 최소 정보를 정한다. 문의 시각, application version, region, request ID, 적용된 variation, 사용자 역할처럼 재현에 필요한 metadata를 안전하게 조회할 수 있어야 한다. 반면 상담원이 flag console의 모든 targeting rule이나 다른 고객 정보를 볼 필요는 없다. support 도구의 권한과 화면도 플래그 운영의 일부다.

재현을 위해 production user의 flag를 임의로 바꾸면 원래 경험을 더 오염시킬 수 있다. 가능한 경우 같은 attribute를 가진 synthetic test user나 read-only replay 환경에서 variation을 재현한다. 꼭 production override가 필요하다면 기간·승인·감사 기록을 두고 종료 뒤 반드시 해제한다. 지원을 편하게 하려는 예외가 영구적인 permission flag가 되지 않게 관리한다.

## 실험 결과와 제품 의사결정

experiment flag는 통계적으로 유의한 숫자만 만드는 도구가 아니다. 실험 전에 성공 지표, guardrail, 대상 제외 조건, 관찰 기간을 정하지 않으면 결과를 보고 나서 유리한 해석만 고르기 쉽다. conversion이 올라도 오류·refund·support burden이 늘었다면 출시 판단은 달라질 수 있다. 실험 대상이 신규 사용자에만 치우쳤다면 전체 고객에게 일반화할 수 있는지도 검토한다.

실험이 끝나면 winning variation을 default로 정하고 flag·분기·dashboard를 제거할 계획을 만든다. 결과가 불명확하면 실험을 무한히 연장하기보다 어떤 추가 데이터나 제품 결정이 필요한지 명시한다. 실험의 목적은 영구적인 두 경로를 만드는 것이 아니라, 다음 제품 결정을 위한 근거를 얻는 것이다.

## 모바일과 오래된 client의 호환성

모바일 application은 사용자가 즉시 최신 version으로 업데이트하지 않기 때문에, server가 새 flag variation을 켠 뒤에도 오래된 client가 남아 있을 수 있다. 새 response field를 추가할 때 이전 client가 무시할 수 있는지, 기존 field의 의미를 바꾸지 않는지, flag on 상태에서만 새 request body를 보내는지 확인한다. client-side flag SDK가 오래된 cached rule을 쓸 수 있다는 점도 고려한다. API contract와 flag rollout을 분리하지 않으면 특정 app version에서만 오류가 나는 문제를 늦게 발견할 수 있다.

테스트 매트릭스에는 지원하는 최소 client version과 최신 version, flag on/off, network 재연결, 로그인 전후 상태를 넣는다. 더 이상 지원하지 않는 version은 언제 차단하거나 upgrade를 요구할지 제품 정책으로 정하고, 그 전까지 backend가 어떤 fallback을 제공하는지 문서화한다. 사용자의 version을 variation targeting에 쓸 때도 정확한 device fingerprint를 과도하게 수집하지 않도록 최소 정보를 사용한다.

## 실패 주입으로 kill switch를 검증하기

kill switch는 평소에는 꺼야 할 일이 없기 때문에 실제 장애에서 처음 눌러 보면 위험하다. test environment에서 새 경로의 downstream timeout, provider 5xx, schema validation 오류, cache corruption 같은 실패를 의도적으로 만들고 flag를 끈 뒤 기존 경로가 정상으로 돌아오는지 확인한다. 이때 이미 시작된 request와 background job, queue message, retry가 어떤 variation을 계속 쓰는지도 본다.

failover test의 목적은 시스템을 일부러 망가뜨리는 것이 아니라, 중지·복구 경로가 문서와 일치하는지 확인하는 것이다. 어떤 지표가 guardrail을 넘으면 누가 flag를 끄는지, console 접근이 실패하면 API나 configuration repository에서 어떤 대체 경로를 쓰는지, 끈 뒤 어떤 업무 데이터를 확인하는지 runbook에 적는다. kill switch가 code deployment보다 빠르다는 가정도 실제 권한·전파·cache 조건에서 검증해야 한다.

## 비용과 복잡도의 상한 정하기

플래그 provider 호출, rule evaluation, analytics event, dashboard는 모두 비용과 운영 복잡도를 만든다. 플래그를 만들 때 owner와 종료 예정일뿐 아니라 대상 트래픽, 필요한 variation 수, 관찰 지표, 예상 유지 기간을 적으면 영구적인 experiment가 되는 일을 줄일 수 있다. 독립적인 기능마다 새 provider project와 rule을 만드는 대신 기존 context·variation 체계로 해결할 수 있는지 먼저 본다.

비용 절감을 위해 evaluation을 client에만 맡기면 targeting rule과 내부 조건이 노출될 수 있고, server 확인이 사라질 수 있다. 반대로 모든 request에서 remote provider를 동기 호출하면 latency와 장애 의존성이 커진다. cache, local evaluation, server authorization, 집계 관찰을 기능 위험도에 맞춰 조합한다. 가장 복잡한 flag system이 아니라 팀이 장애 중에도 이해하고 정리할 수 있는 system이 좋은 선택이다.

## release 종료 확인

100% rollout을 했다고 release가 끝난 것은 아니다. 새 기본 경로가 모든 supported client와 worker에서 동작하는지, 이전 variation을 보는 instance가 없는지, migration과 data backfill이 완료됐는지, rollback window가 종료됐는지 확인한다. 그 뒤 flag key, dead code, test override, dashboard query, alert rule, documentation을 함께 제거한다. 일부를 남기면 다음 변경에서 그 분기가 여전히 의미 있는지 판단하는 비용이 커진다.

제거 commit은 작아 보여도 중요한 품질 작업이다. 기존 default와 새 default가 바뀌는 순간을 code review로 확인하고, 제거 뒤 핵심 scenario를 다시 실행한다. 플래그를 정리할 수 없다는 것은 처음의 출시 계획이나 data compatibility가 충분하지 않았다는 신호일 수 있으므로, 다음 release의 설계에 반영한다.

## 조직 차원의 운영 규칙

플래그를 만드는 팀마다 key naming, default, owner, cleanup 방식이 다르면 중앙 dashboard가 있어도 상태를 이해하기 어렵다. 최소한 환경 구분, owner, 생성일, 목적, 종료 예정일, variation 설명, 대상 규칙 변경 권한이라는 공통 metadata를 정한다. 이 규칙은 새 도구를 도입하는 일보다 먼저 spreadsheet나 repository 문서로 시작할 수 있다. 시간이 지나 반복되는 오류가 보이면 그때 lint, template, provider API 자동화를 추가한다.

운영 규칙은 배포 속도를 늦추기 위한 승인 절차가 아니라, release가 끝난 뒤 누구도 이해하지 못하는 스위치를 남기지 않기 위한 약속이다. 고위험 flag는 security·DBA·QA와 미리 검토하고, 저위험 UI flag는 팀이 빠르게 만들고 짧은 기간에 제거할 수 있게 기준을 차등화한다. 모든 flag를 같은 무게로 관리하면 중요한 위험이 묻히고, 아무 규칙이 없으면 기술 부채가 쌓인다.

## 테스트 자동화의 유지보수

플래그 테스트가 늘면 assertion을 복사해 variation 이름만 바꾸는 방식이 유혹적이다. 하지만 variation별로 무엇이 달라야 하는지 드러나지 않으면 default 변경 때 많은 테스트가 이유 없이 깨진다. 공통 business invariant와 variation 고유 기대를 분리하고, test 이름에 flag·context·의도를 적는다. 예를 들어 주문 총액이 음수가 되지 않는 규칙은 모든 variation에 공통이고, 새 할인 엔진만의 rounding 규칙은 on scenario에만 해당한다.

테스트 helper는 flag provider를 완전히 흉내 내는 거대한 fake가 되지 않게 주의한다. 실제 provider의 cache·targeting·timeout을 모두 구현하려 하면 helper가 또 다른 제품이 된다. 단위 테스트는 작은 evaluator stub으로 결정성을 확보하고, provider와의 통합 behavior는 적은 수의 integration test와 sandbox environment에서 확인하는 층을 나누는 편이 유지보수하기 쉽다.

## 배포 전 마지막 확인

release 직전에는 flag key·default·대상 규칙·owner·종료 예정일이 의도와 맞는지 다시 확인한다. staging에서 on/off와 provider timeout을 확인하고, production rollout에서는 canary 대상·guardrail·중지 권한·연락 경로를 준비한다. 이 작은 확인은 테스트를 한 번 더 돌리는 의식이 아니라, code·configuration·운영 책임이 같은 release를 보고 있는지 확인하는 단계다.

확인 결과와 제외한 위험을 release 기록에 남기면, 다음 담당자가 rollout 속도와 검증 범위를 다시 추측하지 않아도 된다. 플래그를 쓴다는 사실보다 그 플래그가 어떤 경로를 만들고 언제 사라질지 아는 것이 안전한 운영의 출발점이다.

플래그의 lifecycle이 짧고 검증 기준이 명확할수록 배포 속도와 시스템 단순성을 함께 유지하기 쉽다.

그래서 생성 단계의 편의보다 제거 가능한 설계와 책임 있는 종료 조건을 먼저 정하는 편이 좋다.

이 원칙은 작은 UI 실험부터 데이터 경로가 바뀌는 대형 release까지 같은 방향을 제공한다.

변경을 이해할 수 있어야 안전하게 되돌릴 수도 있다.

## 한계와 적용 기준 Q&A

### Q. 기능 플래그를 쓰면 blue-green이나 canary 배포가 필요 없나요?

A. 서로 다른 문제를 다룬다. 인프라 배포 전략은 binary·환경·트래픽 경로의 위험을 줄이고, 기능 플래그는 코드 안의 동작 공개를 제어한다. 둘을 조합할 수 있지만 하나가 다른 하나를 대체한다고 보면 안 된다.

### Q. 모든 bug fix에 플래그를 붙여야 하나요?

A. 아니다. 단순하고 명확한 수정까지 flag를 추가하면 분기와 정리 비용이 더 커질 수 있다. 영향 범위가 크거나 되돌림 속도가 중요한 변경, 실험·점진 공개가 필요한 기능에 우선 사용한다.

### Q. 플래그 서비스가 장애 나면 어떻게 하나요?

A. 각 flag의 fail-safe default, cache TTL, timeout, 마지막 알려진 값 사용 여부를 설계하고 장애 시나리오로 테스트해야 한다. 결제와 권한처럼 위험한 기능은 availability와 fail-closed 요구를 별도로 판단한다.

## 마무리

기능 플래그는 배포와 공개를 분리해 위험을 줄이지만, 실행 경로와 데이터 호환성의 복잡도를 만든다. 플래그 목적과 종료 조건을 기록하고, 고위험 상호작용·default·provider 장애·rollback을 테스트하며, 점진 rollout의 관찰과 정리까지 완료해야 한다. 좋은 플래그 운영은 많은 스위치를 유지하는 일이 아니라 안전하게 기능을 공개한 뒤 다시 code를 단순하게 만드는 일이다.

<h3 class="references-heading">참고 자료</h3>

- [Martin Fowler: Feature Toggles](https://martinfowler.com/articles/feature-toggles.html)
- [OpenFeature Documentation](https://openfeature.dev/docs/)
- [Google SRE Book: Canarying Releases](https://sre.google/sre-book/canarying-releases/)
- [LaunchDarkly: Testing feature flags](https://launchdarkly.com/docs/guides/flags/testing-code)
