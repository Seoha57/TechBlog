---
layout: post
title: "대량 LLM 작업을 설계하는 법: 배치 추론·멱등성·결과 정합성으로 안전하게 처리하기"
categories: [AI]
tags: [ai, llm, batch, api, reliability, idempotency, operations]
description: "대량 요약·분류·평가 작업을 실시간 호출과 구분하고, JSONL 입력·멱등성 키·상태 추적·결과 대조·재처리 기준을 갖춘 배치 LLM 파이프라인 설계를 설명합니다."
---

## 먼저 답하기

### Q. LLM 배치 처리는 요청을 한꺼번에 많이 보내는 것인가요?

A. 아니다. 대량 언어 모델 작업을 안전하게 처리한다는 것은 병렬 호출 수를 키우는 일보다, 입력 집합을 고정하고 각 항목의 처리 상태와 결과를 다시 연결할 수 있게 만드는 일에 가깝다. 배치(batch) 처리는 즉시 화면에 답을 보여 줄 필요가 없는 요약·분류·태깅·품질 평가 같은 작업을 모아 제출하고, 비동기적으로 끝난 결과를 검증·반영하는 방식이다. 단순히 루프에서 API를 수천 번 호출하면 rate limit, 중복 실행, 부분 실패, 결과 유실을 스스로 관리해야 한다.

### Q. 배치 API를 쓰면 실시간 호출보다 항상 싸고 좋은가요?

A. 아니다. 제공자마다 비용·완료 시간·지원 기능·보존 기간·제한이 다르며, 배치 작업은 즉시 취소나 한 항목만의 대화형 수정에 적합하지 않을 수 있다. 고객 채팅의 다음 답처럼 지연 시간이 중요한 경로는 streaming 또는 일반 실시간 API가 더 맞을 수 있다. 반면 전날 문의 5만 건을 다음 날 아침까지 분류하는 일처럼 완료 기한이 넉넉하고 재처리 가능한 업무에는 배치가 운영을 단순하게 할 수 있다.

## 먼저 알아둘 기반 기술

### LLM과 추론 요청

LLM(Large Language Model, 대량의 텍스트를 학습해 다음 토큰을 생성하는 언어 모델)은 입력 프롬프트와 설정을 바탕으로 텍스트나 구조화된 출력을 만든다. 여기서 추론(inference)은 이미 학습된 모델에 실제 업무 입력을 넣어 결과를 받는 단계다. 모델의 품질만 생각하기 쉽지만, 대량 처리에서는 어떤 입력이 어느 모델·프롬프트·스키마로 실행됐는지 기록하지 않으면 결과를 설명하거나 다시 만들기 어렵다.

### 동기 호출과 비동기 배치의 차이

동기(synchronous) 호출은 요청을 보내고 응답을 기다린다. 사용자가 버튼을 누른 뒤 답을 바로 보여줘야 하는 화면에는 자연스럽다. 반면 비동기(asynchronous) 배치는 입력 파일 또는 작업 목록을 제출한 뒤, 작업 상태를 조회하거나 완료 알림을 받고 결과 파일을 수집한다. 제출 시점과 완료 시점이 분리되므로, 호출 코드가 기다리는 시간은 줄일 수 있지만 상태 관리와 결과 대조 책임이 생긴다.

### JSON Lines와 custom ID

JSON Lines(JSONL)는 한 줄에 하나의 JSON 객체를 두는 텍스트 형식이다. 대량 요청에서 줄 단위로 입력과 결과를 처리하기 편해 널리 쓰인다. 각 줄에는 요청 본문뿐 아니라 `custom_id`처럼 업무 항목과 결과를 다시 연결하는 식별자를 둔다. 결과의 행 순서가 입력 행 순서와 같다고 가정하면 안 된다. 일부 항목이 재시도되거나 실패하거나 제공자 내부 처리 순서가 달라질 수 있으므로, 결과는 항상 stable ID로 join해야 한다.

### 멱등성이라는 안전장치

멱등성(idempotency)은 같은 요청을 여러 번 실행해도 의도한 최종 효과가 한 번 실행한 것과 같도록 만드는 성질이다. LLM에게 같은 글을 두 번 요약시키는 비용 중복도 문제지만, 더 위험한 것은 그 결과를 ticket 상태 변경, 이메일 발송, 금액 계산, 고객 등급 수정 같은 외부 효과에 바로 연결하는 경우다. 배치의 한 항목이 timeout 되었을 때 "실패했으니 다시 제출"이라고 판단하면 실제로는 이미 완료된 항목을 중복 처리할 수 있다. 업무 키, 입력 hash, 모델·프롬프트 version, 실행 attempt를 분리해 기록해야 이유를 추적할 수 있다.

## 왜 대량 작업은 별도의 설계가 필요한가

개발 초기에 고객 문의 요약 기능을 만들었다고 하자. 관리자가 버튼을 누르면 최근 문의를 조회해 for-loop로 모델 API를 호출하고 결과를 데이터베이스에 넣는다. 문의가 50건일 때는 문제없어 보인다. 하지만 과거 10만 건을 재분류하려는 날에는 문제가 한꺼번에 드러난다. 네트워크 오류 뒤 어디까지 저장됐는지 알 수 없고, rate limit을 만나면 여러 worker가 동시에 재시도하며 더 큰 burst를 만든다. 프롬프트를 바꾼 뒤 예전 결과와 새 결과가 섞이고, 한 항목의 형식 오류가 전체 job을 멈추거나 조용히 누락시킬 수 있다.

배치 파이프라인은 이 문제를 네 단계로 분리한다. 첫째, 대상 집합을 snapshot으로 고정한다. 둘째, 각 항목을 검증된 요청 레코드로 만든다. 셋째, 제출·진행·완료 상태를 업무 데이터와 분리해 추적한다. 넷째, 결과를 custom ID로 대조하고 schema·업무 규칙을 확인한 뒤에만 반영한다. 이 구조가 있으면 "전체 재실행" 대신 실패한 항목만 다시 처리할 수 있고, 어떤 데이터가 어떤 정책으로 만들어졌는지 설명할 수 있다.

## 실시간 경로와 배치 경로를 나누는 기준

다음 표는 절대적인 규칙이 아니라 업무 성격을 정리하는 출발점이다.

| 질문 | 실시간 호출이 맞는 경우 | 배치 처리가 맞는 경우 |
| --- | --- | --- |
| 사용자는 언제 결과가 필요한가 | 화면에 머무는 몇 초 안 | 수십 분 또는 다음 영업일 안 |
| 실패 시 어떻게 보이는가 | 재질문·대체 화면·사람 연결 | 재시도 큐·실패 목록·후속 정산 |
| 입력 규모는 어떤가 | 한 건 또는 작은 대화 | 수천~수백만 독립 항목 |
| 결과 반영은 어떤가 | 즉시 UI에 표시 | 검증 뒤 DB·warehouse에 반영 |
| 비용과 처리량은 어떤가 | 낮은 지연 우선 | deadline 안의 안정적 처리 우선 |

실시간 기능을 배치로 바꾸는 이유가 "모델이 느리다" 하나라면 다시 생각할 필요가 있다. 사용자가 기다리는 기능은 대기 시간을 줄이는 설계, streaming, 작은 모델, caching, 입력 축소가 더 적절할 수 있다. 반대로 실시간 API를 대량 백필에 쓰는 이유가 "구현이 익숙하다"라면, job 상태와 retry를 직접 다루는 비용이 나중에 더 커질 수 있다.

## 입력을 만드는 단계: 데이터 품질이 모델 호출보다 먼저다

### 대상 집합을 고정한다

"현재 열린 문의 전부"는 배치 대상 정의로 불완전하다. job이 두 시간 실행되는 동안 새 문의가 생기고 상태가 바뀌기 때문이다. 조회 기준 시각, tenant, 상태, 제외 조건, source version을 job manifest에 기록한다. 예를 들어 `created_at < 2026-11-15T00:00:00Z`, `status = resolved`, `source_snapshot = support_export_20261115`처럼 재현 가능한 기준을 둔다.

원본 데이터를 완전히 복제해야 한다는 뜻은 아니다. 개인정보와 보존 정책을 먼저 적용해야 한다. 모델에 보낼 필요가 없는 이메일, 전화번호, 상세 주소, 내부 토큰은 projection 단계에서 제거하거나 마스킹한다. 배치이므로 입력을 대량으로 한 번에 보낸다는 사실은 데이터 최소화 원칙을 더 중요하게 만든다. 샘플 데이터로 먼저 프롬프트를 검증하고, 승인된 field만 export하도록 query를 좁힌다.

### 입력 레코드의 최소 필드

대량 분류 작업의 한 행에는 대체로 다음 정보가 필요하다.

```json
{
  "custom_id": "ticket:184392:prompt-v3",
  "method": "POST",
  "url": "/v1/responses",
  "body": {
    "model": "example-model-2026-01-01",
    "input": "다음 문의를 category, urgency, summary로 분류하세요: ...",
    "metadata": {
      "source_id": "184392",
      "prompt_version": "support-triage-v3"
    }
  }
}
```

여기서 `custom_id`는 사용자에게 보여 줄 문자열이 아니라 결과를 안정적으로 연결하는 키다. ticket ID만 쓰면 같은 ticket을 프롬프트 v2와 v3으로 평가할 때 충돌할 수 있다. 반대로 timestamp를 매 실행마다 넣으면 같은 입력을 재시작했을 때 어느 결과가 최신인지 판단하기 어려워진다. 업무 ID, 입력 version, prompt version, 필요하면 모델 pinning 값을 조합하되, database의 별도 batch item 테이블에도 같은 키와 hash를 저장하는 편이 안전하다.

### JSONL을 제출하기 전에 하는 검증

파일을 만든 직후 제출하지 말고 최소한 다음을 자동 검사한다.

- 줄마다 유효한 JSON인가?
- `custom_id`가 비어 있거나 중복되지 않았는가?
- 모델 이름, endpoint, 요청 method가 의도한 값인가?
- 입력 글자 수·토큰 예산이 정책 범위를 넘지 않는가?
- 허용되지 않은 개인정보 field나 원문 첨부가 포함되지 않았는가?
- 출력 schema와 prompt version이 job manifest에 기록됐는가?

JSON 문법이 맞는다고 업무 입력이 맞는 것은 아니다. 예를 들어 summary용 필드에 HTML 전체 문서를 넣거나, 이미 삭제된 ticket을 포함하거나, 지원 팀만 봐야 할 내부 메모를 넣는 일은 JSON parser가 발견하지 못한다. export query와 field mapping을 코드 리뷰하고, 소량 샘플을 사람이 읽는 절차가 여전히 필요하다.

## 제출과 상태 추적: 파일 ID가 업무 완료를 뜻하지 않는다

제공자별 API 이름은 다르지만 일반적인 순서는 입력 파일 업로드, batch 생성, 상태 polling 또는 webhook 수신, output과 error 파일 다운로드다. OpenAI Batch API 문서처럼 JSONL 입력을 제출하는 서비스에서는 입력 파일과 batch job을 별도 객체로 다룰 수 있다. 이때 upload가 성공해도 모델 처리가 시작됐다는 뜻은 아니고, job이 completed가 되어도 모든 항목이 성공했다는 뜻은 아니다.

그래서 내부에는 최소한 batch job과 batch item이라는 두 수준의 상태를 둔다.

| 수준 | 기록할 값 | 필요한 이유 |
| --- | --- | --- |
| batch job | provider batch ID, 입력 snapshot, 제출 시각, deadline, 상태 | 한 번의 실행 단위를 추적 |
| batch item | custom ID, source ID, 입력 hash, attempt, 결과 상태 | 부분 실패와 재처리 관리 |
| 결과 version | model ID, prompt ID, schema ID, parser version | 결과의 의미와 재현성 설명 |

job 상태가 `in_progress`일 때 polling 주기를 너무 짧게 두면 상태 조회 자체가 불필요한 호출이 된다. webhook을 지원하면 서명 검증과 중복 delivery 처리를 포함해 event를 받는 방법을 검토할 수 있다. polling을 쓴다면 backoff와 최대 대기 시간을 두고, deadline을 넘은 job을 무한히 기다리지 않는다. 사용자 화면에는 "처리 중"이라는 상태와 예상 갱신 시각을 보여 주고, 운영자 화면에는 제출된 항목 수·성공·실패·미확정 수를 분리해 보여 준다.

## 결과를 받았을 때 가장 중요한 일: 순서가 아니라 키로 대조하기

배치 output을 받으면 많은 구현이 파일을 순서대로 읽어 원본 배열의 n번째 항목에 붙인다. 이 방식은 부분 실패, 재시도, output 정렬 변화가 있는 순간 깨진다. 올바른 흐름은 결과 행의 `custom_id`를 파싱하고, 내부 batch item 테이블의 custom ID와 join하는 것이다.

다음과 같은 대조 결과를 먼저 만든다.

| 상태 | 의미 | 다음 행동 |
| --- | --- | --- |
| 입력과 결과가 한 번씩 일치 | 정상 후보 | schema·업무 검증 후 반영 |
| 입력은 있으나 결과 없음 | 누락 또는 아직 미수집 | job 상태·error file 확인 후 재처리 후보 |
| 결과는 있으나 입력 없음 | 잘못된 파일·중복 결과 가능성 | 자동 반영 중지, 원인 조사 |
| 같은 custom ID 결과가 여러 개 | 중복 제출·재시도 결과 가능성 | attempt와 완료 시각으로 정책적 선택 |
| provider error가 있는 행 | 항목별 실패 | 오류 유형에 따라 수정·재시도·보류 |

이 대조는 데이터베이스의 upsert 전에 끝나야 한다. 결과를 "성공"으로 기록하는 순간은 모델 HTTP 응답을 받은 때가 아니라, 결과가 대상 입력과 정확히 연결되고 parser와 validator를 통과해 의도한 저장소에 반영된 때로 정의하는 편이 좋다. 그래야 재실행 시 이미 반영된 항목과 아직 미반영 항목을 구분할 수 있다.

## 구조화 출력과 업무 검증은 별개다

분류 결과를 다음 JSON schema로 요구한다고 하자.

```json
{
  "category": "billing",
  "urgency": "high",
  "summary": "결제 승인 실패 문의"
}
```

`category`가 허용 enum인지, `urgency`가 문자열인지, summary가 최대 길이를 넘지 않는지는 schema validator가 확인할 수 있다. 그러나 `billing` 분류가 실제로 맞는지, high ticket을 자동으로 담당자에게 배정해도 되는지, 같은 ticket이 이미 사람에 의해 처리됐는지는 schema만으로 알 수 없다. LLM 출력은 외부 입력처럼 취급하고, 형식 검증 뒤에 domain validation과 현재 상태 확인을 추가해야 한다.

예를 들어 자동 배정의 업무 validator는 다음을 검사할 수 있다. ticket이 아직 open 상태인가, tenant가 활성 상태인가, confidence가 사람이 정한 threshold 이상인가, high severity면 human review queue로 보내야 하는가, 기존 담당자의 수동 override가 있는가. 이 검사는 모델에 다시 질문해 해결할 문제가 아니라 application의 현재 데이터와 정책으로 판단해야 하는 문제다.

## 구체적인 업무 예시: 지난 분기 문의를 새 분류 체계로 재태깅하기

지원 조직이 분류 체계를 기존 8개에서 14개로 바꿨다고 하자. 제품 팀은 지난 분기 해결 문의를 새 category로 재태깅해 대시보드를 만들고 싶다. 이 작업을 대화형 화면에서 하나씩 수행하면 오래 걸리고 결과가 섞인다. 다음처럼 batch runbook을 설계할 수 있다.

1. 분석 대상 기간, tenant, 제외할 민감 field, 기존 수동 분류 보존 규칙을 문서로 합의한다.
2. 읽기 전용 snapshot query로 ticket ID와 허용된 본문 field를 export하고, source row count와 checksum을 남긴다.
3. ticket마다 `ticket_id + source_revision + taxonomy_v14 + prompt_v3` 기반 custom ID와 input hash를 만든다.
4. 100건 내외의 샘플을 검토해 prompt, schema, 금지 field, 결과 길이를 수정한다.
5. 승인된 JSONL을 업로드하고 provider batch ID를 내부 job 레코드에 저장한다.
6. 완료된 output과 error를 다운로드해 custom ID 집합을 대조한다.
7. JSON parser, enum validator, ticket 현재 상태 validator를 통과한 결과만 staging table에 넣는다.
8. 담당자가 표본을 검토한 뒤 production 분석 테이블로 promote하고, 실패·보류 항목만 별도 재처리 batch로 만든다.

여기서 원본 ticket의 live category를 바로 덮어쓰지 않는 것이 중요하다. 분석용 재태깅은 새 결과 version을 별도 column이나 table에 저장하고, 기존 사람이 붙인 값과 비교할 수 있게 한다. 차이가 큰 category, 너무 짧은 summary, 특정 언어에서 실패가 많은 항목은 품질 개선 후보가 된다. batch가 끝났다는 사실은 모델 호출이 끝났다는 사실이지, taxonomy migration의 품질이 검증됐다는 사실은 아니다.

## 재시도 정책: 오류 종류마다 같은 답을 쓰지 않는다

대량 작업에서 모든 실패를 즉시 재시도하면 비용과 혼잡을 키운다. 오류를 최소한 네 종류로 나눈다.

| 실패 유형 | 예시 | 우선 행동 |
| --- | --- | --- |
| 일시적 전송 실패 | timeout, 5xx, 네트워크 단절 | jitter가 있는 제한된 재시도 |
| 입력 오류 | 너무 긴 본문, 잘못된 JSON, 금지 field | 입력 수정 후 새 attempt |
| 출력 오류 | JSON parse 실패, enum 불일치 | schema·prompt 점검, 제한적 repair 또는 review |
| 업무 상태 오류 | 이미 종료된 ticket, 권한 변경, 중복 반영 | 현재 상태 확인 후 보류 또는 skip |

재시도는 항상 같은 custom ID를 써야 한다는 뜻이 아니다. 원본 입력과 정책이 변하지 않았다는 것을 증명할 수 있다면 stable key를 유지하고 attempt 번호를 별도 기록한다. 프롬프트나 taxonomy가 바뀌었다면 새 version key를 만들고 이전 결과와 구분해야 한다. 그렇지 않으면 "어떤 결과가 최신인가"라는 질문에 실행 시각밖에 답할 수 없게 된다.

## 비용·처리량·기한을 함께 계산하기

배치를 선택할 때는 건수만 세지 말고 입력 토큰, 출력 상한, 모델별 단가, 완료 기한, 실패 재처리량을 함께 추정한다. 입력 10만 건이 모두 같은 비용을 쓰지 않는다. 긴 문의 몇 개가 토큰 예산을 크게 차지할 수 있고, 출력 제한이 너무 크면 요약 작업인데도 비용과 완료 시간이 불필요하게 늘어난다. 반대로 출력을 지나치게 짧게 제한하면 중요한 조건을 빼거나 JSON을 끝까지 닫지 못하는 품질 문제가 생길 수 있다.

먼저 작은 representative sample에서 입력 길이 분포와 expected output 길이를 측정한다. 그 후 정책상 너무 긴 항목을 별도 경로로 보내거나, 본문을 section별로 자르는지, 사람이 검토하도록 제외하는지 결정한다. 이 글은 특정 제공자 가격이나 처리 시간 수치를 보장하지 않는다. 서비스의 최신 제한·가격·보존 조건은 실제 제출 전에 해당 제공자의 공식 문서를 확인해야 한다.

또한 batch submission을 비용 승인 경계로 본다. 예상 토큰 상한, 최대 작업 수, tenant별 quota, 실행자, 승인자, 비용 center를 job manifest에 남기면 실수로 전체 테이블을 다시 처리하는 사고를 줄일 수 있다. 개발 환경과 production 환경의 API key·project·데이터를 분리하고, production batch를 local script 한 줄로 누구나 제출할 수 있게 두지 않는 편이 안전하다.

## 저장소 설계: 결과 테이블 하나로 끝내지 않기

작은 실험에서는 `tickets.ai_category` 같은 column 하나에 결과를 넣고 끝낼 수 있다. 그러나 프롬프트를 개선하거나 모델을 교체하면 같은 ticket에 여러 결과 version이 생긴다. 이때 기존 값을 덮어쓰면 어느 실행이 결과를 만들었는지, 사람이 수정한 값이었는지, 품질 평가에서 비교한 후보가 무엇인지 알 수 없게 된다. 대량 처리는 결과를 "현재 정답"이 아니라 특정 정책과 시점으로 만든 후보 산출물로 다루는 편이 안전하다.

간단한 data model은 다음 네 종류의 레코드로 시작할 수 있다.

| 레코드 | 핵심 식별자 | 역할 |
| --- | --- | --- |
| batch_run | run_id | snapshot·제출자·provider job·기한을 가진 실행 단위 |
| batch_item | run_id + custom_id | 입력 hash·상태·attempt·오류를 가진 항목 단위 |
| ai_result | result_id | parser를 통과한 원본 model output과 version |
| applied_decision | source_id + policy_version | 실제 업무 테이블에 반영한 값과 승인 근거 |

이 구조가 꼭 거대한 플랫폼을 뜻하지는 않는다. 관계형 데이터베이스의 작은 테이블 몇 개로도 시작할 수 있다. 중요한 점은 API 응답을 받은 기록과 업무 데이터에 적용한 기록을 분리하는 것이다. `batch_item`이 provider에서 성공했다고 해도 `applied_decision`이 없으면 아직 업무 반영은 끝나지 않은 것이다. 반대로 사람이 직접 수정해 이미 적용한 항목은 다음 batch가 덮어쓰지 않도록 decision 기록에서 보호할 수 있다.

### 상태 전이는 제한적으로 설계한다

상태 이름을 많이 만들수록 안전해지는 것은 아니다. 다음처럼 각 상태가 의미하는 바와 허용되는 다음 상태를 정하면 충분하다.

```text
prepared -> submitted -> running -> collected -> validated -> applied
                         |              |              |
                         v              v              v
                      cancelled       failed        awaiting_review
```

`prepared`는 입력 파일 검증을 통과했지만 provider에 제출하지 않은 상태다. `submitted`는 provider job ID를 받았다는 뜻이고, `running`은 제공자가 실제 실행 중이라고 보고한 상태다. `collected`는 결과 파일을 다운로드했을 뿐 검증하지 않은 상태다. `validated`는 custom ID 대조와 parser·업무 검증을 통과한 상태이며, `applied`는 트랜잭션으로 target storage에 반영한 상태다. 이 구분이 있으면 운영자는 "왜 완료가 100%가 아닌가"라는 질문에 실제 막힌 단계를 답할 수 있다.

상태 업데이트에는 compare-and-set 또는 transaction 같은 동시성 보호가 필요하다. scheduler가 polling과 webhook 재처리를 모두 실행할 수 있고, 두 worker가 같은 output을 받으면 같은 항목을 두 번 applied로 기록할 수 있기 때문이다. unique key, optimistic lock, upsert 조건 중 현재 저장소에 맞는 최소한의 보호를 선택한다. 멱등성 키는 external API에만 필요한 개념이 아니라 내부 state machine에도 필요하다.

## 입력과 결과의 버전을 어떻게 관리할까

### 모델 이름을 alias로만 저장하지 않는다

일부 API의 최신 모델 alias는 시간이 지나 다른 snapshot 또는 동작으로 이어질 수 있다. 엄격한 재현성이 필요하다면 실제 model identifier, 제공자 문서의 version 정보, 실행 시각을 결과와 함께 기록한다. 모델 ID만으로 완전한 재현을 보장할 수 없는 제공자도 있으므로, "같은 결과를 다시 만들 수 있다"고 단정하지 말고 재현 가능한 범위를 문서화한다.

프롬프트도 문자열 하나로 취급하지 않는다. 지원 분류 프롬프트의 instruction, few-shot example, 출력 schema, 안전 규칙, localization 문구가 바뀌면 결과 분포가 달라질 수 있다. Git commit 또는 prompt registry version을 기록하고, 중요한 변경에는 대표 입력 evaluation을 수행한다. 대량 batch는 모델과 prompt를 시험하는 좋은 기회가 될 수 있지만, production 원본 전체를 첫 실험의 평가셋으로 사용해서는 안 된다.

### 원본 변경 감지

job을 준비한 뒤 결과를 받기 전에도 원본 ticket은 수정될 수 있다. 입력 hash를 저장하면 "현재 ticket 본문이 batch에 넣은 본문과 같은가"를 비교할 수 있다. hash가 다르면 오래된 결과를 live record에 자동 적용하지 않고, 새 revision으로 다시 준비하거나 사람 검토로 보낸다. 특히 고객이 추가 메시지를 남긴 support ticket, 문서가 개정된 knowledge base, 가격이 바뀐 상품 설명처럼 빠르게 변하는 source에서는 이 확인이 중요하다.

source ID만 같다는 이유로 결과가 아직 유효하다고 가정하지 않는다. `source_revision`, `snapshot_at`, `input_hash` 중 현재 시스템이 제공하는 안정적인 값을 선택해 condition을 만든다. 버전 값이 없으면 batch를 도입하기 전에 원본 데이터의 수정 시각·revision 설계부터 보완하는 것이 더 근본적인 해결일 수 있다.

## 부분 실패를 복구하는 구체적 절차

100,000건을 제출했는데 output에는 99,700건 성공, 180건 provider error, 90건 parser 실패, 30건 결과 누락이 있다고 하자. 전체 batch를 새로 제출하는 것은 가장 쉬운 명령이지만 좋은 복구는 아니다. 다음 순서로 범위를 좁힌다.

1. 입력 manifest의 건수와 custom ID set을 기준으로 결과·오류 파일의 ID set을 각각 만든다.
2. 결과와 오류 양쪽에 없는 30건은 job 상태, 다운로드 오류, 파일 누락 여부를 먼저 확인한다.
3. provider error 180건은 상태 코드와 error code를 분류한다. 일시 오류와 policy·입력 오류를 섞지 않는다.
4. parser 실패 90건은 원문 output을 접근 통제된 저장소에서 표본 검토한다. 빈 응답, 잘린 JSON, 예상하지 못한 enum을 구분한다.
5. 현재 source revision이 같은 항목만 retry candidate로 만든다. source가 바뀐 항목은 새 batch version으로 간다.
6. retry batch에는 원래의 전체 파일이 아니라 확정된 후보의 custom ID와 parent run ID를 넣는다.
7. 재처리 결과도 같은 대조·검증 절차를 거친 뒤, final reconciliation report에서 최초·재시도·보류 수를 합산한다.

이 절차의 핵심은 실패 파일을 즉시 재전송하지 않는 것이다. "누락"은 provider 실패가 아니라 internal collector bug일 수 있고, parser 실패는 prompt 또는 schema 설계 문제일 수 있다. 같은 입력을 같은 방식으로 재시도해도 반복될 가능성이 높은 오류는 먼저 원인을 고친 뒤 새 정책 version으로 처리해야 한다.

### Dead-letter queue를 어디에 쓰는가

반복 재시도해도 처리할 수 없는 항목은 dead-letter queue(DLQ, 일반 처리 흐름에서 분리해 조사하는 실패 항목 보관소)로 보낼 수 있다. DLQ는 실패를 숨기는 쓰레기통이 아니다. owner, 오류 분류, 다음 검토 날짜, 개인정보 보존 기한, 재처리 조건을 가진 작업 목록이어야 한다. 예를 들어 너무 긴 법률 문서, 암호화된 첨부, 손상된 인코딩, 정책상 외부 모델에 보내면 안 되는 ticket은 자동 재시도 대신 별도 경로가 더 적합하다.

DLQ가 계속 늘면 소비자 코드만 늘리지 말고 upstream data contract를 고친다. 입력 길이 제한을 export 전에 검사하고, 지원하지 않는 MIME type을 분리하고, sensitive classification을 먼저 수행하는 식이다. batch system의 품질은 성공률 하나가 아니라 실패가 얼마나 설명 가능하고 재발하지 않게 고쳐지는지로 판단한다.

## 보안과 개인정보: 대량이라는 이유로 기준을 낮추지 않기

배치에는 평소보다 넓은 기간의 고객 데이터가 담길 수 있다. 그래서 개발자가 local laptop에 JSONL을 오래 보관하거나, 디버깅을 위해 team chat에 sample을 붙이는 일이 위험해진다. 입력·output 파일의 저장 위치, 암호화, 접근 역할, 삭제 기한, provider의 데이터 처리 조건을 batch runbook에 포함한다. bucket이나 file storage의 기본 public access 차단, 다운로드 URL의 수명, 다운로드한 임시 파일의 정리도 확인한다.

테스트에는 production 고객 원문 대신 승인된 synthetic 또는 최소화된 데이터를 사용한다. 품질 검토 샘플도 원본 전체보다 redacted excerpt와 필요 메타데이터를 우선한다. 운영자가 오류를 재현해야 할 때 접근을 승격하는 절차를 두면, 편의를 위해 로그와 샘플을 광범위하게 복제하는 일을 줄일 수 있다. 데이터 최소화는 모델 입력 단계에서만 끝나는 규칙이 아니라 export, 파일 전송, 결과 보관, 관찰성 전부에 적용된다.

## 배치 품질을 평가하는 최소 단위

대량 처리 후 사람이 결과 몇 개를 보고 "괜찮다"고 판단하면 편향된 결과를 놓칠 수 있다. category, 언어, 길이, urgency, tenant, 입력 결측 여부처럼 결과가 달라질 수 있는 층을 나눠 표본을 뽑는다. 정확한 정답이 있는 분류라면 사람 라벨과 일치율·confusion matrix를 볼 수 있고, 요약이라면 사실 보존·금지 정보 노출·행동 가능성 같은 rubric을 정의할 수 있다.

평가셋은 batch와 분리된 고정 집합으로 유지하는 것이 좋다. 새 모델 또는 prompt 변경 때 같은 대표 사례를 먼저 비교하면 production 전체 재처리 전에 regression을 잡을 수 있다. 물론 고정 평가셋만 최적화하면 실제 데이터 변화에 약해질 수 있으므로, 주기적으로 최신 데이터에서 안전하게 표본을 추가한다. 품질 지표는 모델 선택의 근거이며, 그 자체가 자동 승인 규칙은 아니다.

## 운영자가 따라 할 수 있는 runbook

### 제출 전

업무 owner가 대상 범위와 비용 상한을 승인하고, data owner가 전송 가능 field를 확인한다. 실행자는 source snapshot row count와 checksum, prompt·schema·model version, 예상 완료 기한을 run record에 넣는다. 입력 validator가 통과하지 못한 행은 provider로 보내지 않고 즉시 원인과 함께 분리한다.

### 실행 중

provider job 상태와 내부 scheduler 상태를 일정한 간격으로 수집한다. deadline이 가까워졌는데 완료 비율이 낮으면 duplicate batch를 즉시 만들어서는 안 된다. 기존 batch가 아직 처리 중인지, 제공자 상태가 지연인지, polling worker가 중단됐는지 먼저 확인한다. 비용 사용량이 예상치를 넘으면 새 제출을 중단하고 input 길이 분포와 재시도 폭주를 조사한다.

### 완료 후

결과 파일을 immutable한 run artifact로 보관할지, 정책상 즉시 삭제할지 결정한다. custom ID 대조, parser, domain validation, source revision check를 통과한 항목만 staging에 적재한다. apply 전에는 성공률뿐 아니라 category 분포 변화, 빈 결과 비율, review queue 비율을 전 batch와 비교한다. 예상과 크게 다르면 live 반영을 멈추고 prompt·model·source 형식 변경을 조사한다.

## 관찰성과 감사 가능성

배치 파이프라인에는 모델 응답 전문을 모두 로그로 남기는 방식보다, 필요한 운영 필드를 구조화해 남기는 방식이 적합하다. 예를 들면 다음 필드를 기록할 수 있다.

```text
batch_id, batch_item_id, custom_id, source_id_hash,
model_id, prompt_version, schema_version, input_token_bucket,
provider_status, parser_status, validator_status, retry_attempt,
result_version, applied_at, reviewer_decision
```

`source_id_hash`처럼 필요한 범위의 내부 식별자를 쓰면 로그에서 작업 흐름을 따라갈 수 있으면서 원문이나 개인정보를 넓게 노출하는 일을 줄일 수 있다. 모델 output 전문은 품질 조사를 위해 필요할 수 있지만, 기본 로그에 무기한 남기기보다 접근 통제된 저장소와 보존 기간을 정한다. 오류를 재현하려면 원본 전체가 아니라 redacted sample, input hash, prompt version, parser version, 정책을 함께 보관하는 편이 더 안전한 경우가 많다.

대시보드에는 제출 건수만 보여 주지 말고 `submitted`, `completed`, `provider_error`, `parse_failed`, `business_rejected`, `applied`, `awaiting_review`를 분리한다. completed가 높아도 applied가 낮다면 모델 호출 문제가 아니라 schema나 업무 validator 문제가 있을 수 있다. 이 구분이 있어야 팀이 "LLM 품질이 나쁘다"라는 막연한 판단 대신 어느 단계의 병목을 고칠지 결정할 수 있다.

## 한계와 적용 기준 Q&A

### Q. 배치 결과를 자동으로 production 데이터에 반영해도 되나요?

A. 결과의 영향도에 달려 있다. 검색용 태그나 분석용 요약처럼 잘못돼도 되돌리기 쉬운 데이터는 schema와 샘플 검토 뒤 자동 반영을 검토할 수 있다. 반면 고객 계정 상태, 결제, 법적 분류, 해지, 외부 메시지처럼 사람·금전·권리에 영향을 주는 작업은 모델 출력만으로 확정하지 말고 human review 또는 명시적 정책 엔진을 둬야 한다. batch라는 실행 방식이 결과의 신뢰도를 보장하지 않는다.

### Q. 실패한 행만 다시 보내면 항상 안전한가요?

A. 아니다. 실패 목록을 만들기 전에 provider output, 내부 item 상태, 실제 적용 기록을 대조해야 한다. 네트워크 timeout 때문에 응답을 못 받은 항목이 실제로 완료됐을 수 있다. 같은 custom ID의 결과가 이미 staging에 들어갔는지, 원본 ticket이 바뀌지 않았는지, 프롬프트 version이 그대로인지 확인한 뒤 재시도한다. 이 과정이 멱등성 설계의 핵심이다.

### Q. JSON schema를 사용하면 hallucination이 없어지나요?

A. 아니다. schema는 형태와 허용 값을 제한할 뿐 사실성이나 업무적 적절성을 보장하지 않는다. `category`가 `billing`이라는 enum인 것은 확인해도, 실제 문의가 billing인지, summary가 원문을 왜곡하지 않았는지는 별도 평가와 검토가 필요하다. 특히 RAG(Retrieval-Augmented Generation, 검색으로 찾은 근거를 모델 입력에 넣는 방식) 결과를 대량 생성할 때는 문서 version과 인용 근거도 함께 기록해야 한다.

### Q. 제공자 배치 API가 없으면 이 방법을 쓸 수 없나요?

A. 가능하다. 내부 queue, worker, object storage로 비동기 job을 만들 수도 있다. 다만 그 경우에는 rate limit, retry, timeout, dead-letter queue, 결과 파일, 보안, 상태 저장을 직접 운영해야 한다. 이미 제공자가 충족하는 비동기 batch 기능이 있고 요구 사항에 맞는다면, 작은 구현으로 같은 신뢰성을 얻을 수 있는지 먼저 비교하는 편이 좋다.

## 배포 전 점검 목록

- 업무 목적과 완료 기한이 실시간 경로가 아니라 배치에 맞는가?
- 대상 snapshot의 범위·시각·row count·제외 조건을 기록했는가?
- 모델로 전송할 field를 최소화하고 민감 정보 처리 기준을 적용했는가?
- custom ID, 입력 hash, prompt·model·schema version을 분리해 저장하는가?
- JSONL 문법·중복 ID·token 상한·금지 field를 제출 전 검사하는가?
- provider job 상태와 내부 item 상태를 구분해 추적하는가?
- output을 순서가 아니라 custom ID로 입력과 대조하는가?
- parser·schema·업무 validator를 모두 통과한 결과만 반영하는가?
- 재시도 유형과 최대 attempt, backoff, human review 기준이 정의됐는가?
- 비용 상한·권한·보존 기간·삭제 절차가 문서화됐는가?

## 마무리

대량 LLM 작업의 난점은 모델에게 긴 파일을 보내는 데 있지 않다. 어떤 원본을 대상으로 했는지, 어떤 정책과 모델로 실행했는지, 결과가 어느 입력에서 왔는지, 실패와 재시도를 어떻게 구분하는지를 끝까지 연결하는 데 있다. JSONL과 batch API는 입력을 전달하는 편리한 형식일 뿐, 정합성·멱등성·업무 검증을 대신하지 않는다.

처음에는 위험이 낮은 분석·태깅 작업에서 시작하자. 입력 snapshot과 custom ID를 고정하고, 소량 샘플의 품질을 확인한 뒤, output을 대조·검증하는 pipeline을 만든다. 이 구조가 갖춰지면 모델이나 프롬프트를 바꿔도 이전 결과와 비교하고, 일부 실패만 안전하게 재처리하며, 비용과 개인정보 노출을 통제할 수 있다. 좋은 배치 시스템은 가장 많은 요청을 한 번에 보내는 시스템이 아니라, 중간에 멈춰도 무엇이 처리됐는지 분명하고 다시 시작할 수 있는 시스템이다.

<h3 class="references-heading">참고 자료</h3>

- [OpenAI API: Batch](https://developers.openai.com/api/docs/guides/batch)
- [OpenAI API: Background mode](https://developers.openai.com/api/docs/guides/background)
- [OpenAI API: Structured output](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI API: Production best practices](https://developers.openai.com/api/docs/guides/production-best-practices)
- [Google SRE Book: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
