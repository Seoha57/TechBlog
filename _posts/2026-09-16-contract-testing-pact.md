---
layout: post
title: "Contract Testing으로 API 변경을 안전하게 다루기"
date: 2026-09-16 00:00:00 +0900
categories: [qa]
tags: [qa, contract-testing, pact, api, microservices]
---

마이크로서비스가 늘어나면 API 테스트의 질문도 달라집니다. 단순히 “이 서비스의 응답 코드가 200인가?”만 확인하는 것으로는 부족합니다. 주문 서비스가 결제 서비스에 기대하는 필드가 사라지지 않았는지, 사용자 서비스의 응답 타입이 바뀌어도 호출자가 안전한지, 서로 다른 팀이 독립적으로 배포해도 약속이 지켜지는지를 확인해야 합니다.

Contract Testing은 서비스 사이의 약속, 즉 계약을 테스트하는 방법입니다. 이 글에서는 Pact를 대표적인 구현 예시로 삼아, 소비자와 제공자의 관계를 어떻게 검증하는지 정리합니다. 특정 환경에서 실제로 실행한 결과를 말하는 글이 아니라, 공개 문서와 기술 자료를 바탕으로 개념과 적용 판단 기준을 설명하는 글입니다.

<section class="quick-answers"><p class="quick-label">먼저 답하면</p><div class="quick-answer"><h3>Q. Contract Testing은 API 통합 테스트와 같은가요?</h3><p>A. 목적이 다릅니다. 통합 테스트가 여러 서비스를 실제 환경에 연결해 전체 흐름을 확인한다면, Contract Testing은 각 서비스가 상대방과 합의한 요청·응답 형식을 지키는지 빠르게 확인합니다.</p></div><div class="quick-answer"><h3>Q. Pact는 누가 계약을 작성하나요?</h3><p>A. 대표적인 Consumer-Driven Contract 방식에서는 소비자가 필요한 상호작용을 예시로 작성합니다. 제공자는 그 계약을 받아 실제 API가 약속을 지키는지 검증합니다.</p></div><div class="quick-answer"><h3>Q. 모든 API 테스트를 Pact로 바꿔야 하나요?</h3><p>A. 아닙니다. 비즈니스 규칙, 부하, 인증, 실제 인프라 연동은 별도의 테스트가 필요합니다. Pact는 서비스 경계의 호환성 문제를 줄이는 데 초점을 둡니다.</p></div></section>

<figure class="article-figure"><img src="{{ '/assets/images/contract-testing-pact-flow.svg' | relative_url }}" alt="Pact를 활용한 Contract Testing 흐름"><figcaption>이미지 출처: ChatGPT 생성</figcaption></figure>

## 1. Contract Testing이 필요한 이유

서비스가 하나라면 내부 함수의 변경과 테스트를 한 저장소 안에서 조정하기 쉽습니다. 하지만 서비스가 분리되면 호출자는 다른 팀이 관리하는 API를 사용하게 됩니다. 호출자는 응답의 `id`, `status`, `items` 같은 필드를 기대하고, 제공자는 그 필드의 이름과 타입을 유지해야 합니다. 이 약속이 문서에만 남아 있으면 변경 시점에 빠르게 깨지기 쉽습니다.

예를 들어 주문 서비스가 결제 서비스에 다음과 같이 요청한다고 가정해 보겠습니다.

```json
{
  "orderId": "order-1001",
  "amount": 39000,
  "currency": "KRW"
}
```

주문 서비스는 결제 서비스가 다음 응답을 반환한다고 기대할 수 있습니다.

```json
{
  "paymentId": "payment-2001",
  "status": "approved"
}
```

그런데 제공자가 `paymentId`를 `id`로 바꾸거나 `status`를 객체로 변경하면, 제공자 내부 테스트는 통과해도 소비자 화면이나 후속 처리에서 문제가 발생할 수 있습니다. Contract Testing은 이런 변경을 소비자와 제공자의 경계에서 발견하려는 접근입니다.

Martin Fowler는 Consumer-Driven Contracts를 소비자가 필요한 계약을 정의하고 제공자가 이를 만족하는지 확인하는 방식으로 설명합니다. 중요한 점은 거대한 명세를 처음부터 모두 작성하는 것이 아니라, 실제 소비자가 사용하는 상호작용을 계약의 단위로 다룬다는 데 있습니다. [Martin Fowler의 설명](https://martinfowler.com/articles/consumerDrivenContracts.html)은 이 방식이 서비스 간 통합에 필요한 기대를 명시적으로 만드는 과정을 보여줍니다.

## 2. Consumer와 Provider의 역할

Contract Testing에서 Consumer는 API를 호출하는 쪽입니다. Provider는 API를 제공하는 쪽입니다. 한 서비스는 어떤 관계에서는 Consumer이고, 다른 관계에서는 Provider일 수 있습니다. 예를 들어 주문 서비스가 결제 서비스를 호출하면 주문 서비스는 Consumer, 결제 서비스는 Provider입니다.

Consumer는 “내가 이 API를 사용할 때 이런 요청을 보내고 이런 응답을 처리한다”를 계약으로 남깁니다. Provider는 계약에 적힌 요청을 실제 애플리케이션에 전달하고, 응답이 계약과 맞는지 검증합니다. Pact 문서는 이 흐름을 소비자 테스트에서 계약을 만들고, 제공자 검증에서 계약을 재생하는 구조로 설명합니다. [Pact의 동작 방식](https://docs.pact.io/getting_started/how_pact_works)을 보면 계약이 양쪽 테스트를 연결하는 중간 산출물이라는 점을 확인할 수 있습니다.

여기서 “응답에 필드가 더 있어도 되는가?” 같은 호환성 정책도 중요합니다. 소비자가 사용하지 않는 필드가 추가되는 것은 대체로 문제가 아니지만, 기존 필드 삭제나 타입 변경은 문제가 될 수 있습니다. 계약은 API 전체를 복제하는 문서가 아니라 소비자가 실제로 의존하는 부분을 표현해야 합니다.

## 3. Pact 예시로 보는 소비자 계약

Pact의 JavaScript 계열 예시를 단순화하면 다음과 같은 구조가 됩니다. 실제 패키지와 버전에 따라 API 호출 방법은 달라질 수 있으므로, 아래 코드는 흐름을 이해하기 위한 예시로 보는 편이 좋습니다.

```javascript
const pact = await provider.addInteraction({
  states: [{ description: 'order exists' }],
  uponReceiving: 'a request for an order payment',
  withRequest: {
    method: 'POST',
    path: '/payments',
    body: { orderId: 'order-1001', amount: 39000, currency: 'KRW' }
  },
  willRespondWith: {
    status: 200,
    body: { paymentId: 'payment-2001', status: 'approved' }
  }
});
```

이 예시의 핵심은 테스트가 단순히 “응답이 성공했다”만 확인하지 않는다는 점입니다. 어떤 경로에 어떤 메서드로 어떤 본문을 보냈고, 어떤 상태 코드와 응답 본문을 기대하는지가 명시되어 있습니다. 소비자 테스트가 이 계약을 생성하면 Provider 검증 단계에서 같은 상호작용을 실제 서버에 요청해 응답을 비교할 수 있습니다.

계약을 너무 넓게 작성하면 작은 변경에도 많은 서비스가 영향을 받고, 너무 좁게 작성하면 중요한 의존성을 놓칩니다. 예를 들어 주문 화면에서 `status`만 사용한다면 결제 응답의 모든 내부 필드를 계약에 넣을 필요는 없습니다. 반대로 `status`가 `approved`, `failed` 중 하나라는 의미가 비즈니스 흐름에 중요하다면 단순 문자열 존재 여부보다 허용 값까지 명확히 다루는 편이 좋습니다.

Pact 문서는 소비자 테스트가 실제 사용 사례를 계약으로 표현하도록 안내합니다. [Pact Consumer 문서](https://docs.pact.io/consumer)는 요청과 응답의 상호작용을 정의하고, 테스트가 기대하는 예시를 계약으로 생성하는 과정을 설명합니다.

## 4. 계약은 어떻게 Provider까지 전달될까?

가장 단순한 구조에서는 Consumer가 만든 Pact 파일을 Provider 저장소가 직접 가져와 검증할 수 있습니다. 서비스와 팀이 늘어나면 Pact Broker를 중간에 두는 방식이 유용합니다. Broker는 계약과 검증 결과를 저장하고, Consumer와 Provider 버전 사이의 관계를 추적하는 역할을 합니다.

흐름은 다음과 같이 볼 수 있습니다.

1. Consumer 테스트가 통과하면서 Pact 계약을 생성합니다.
2. CI가 계약을 Pact Broker에 게시합니다.
3. Provider CI가 자신이 제공하는 계약을 가져와 검증합니다.
4. Provider 검증 결과가 Broker에 게시됩니다.
5. 배포 파이프라인이 호환 가능한 조합인지 판단합니다.

이 구조의 장점은 서비스 배포 순서에 대한 불안을 줄이는 것입니다. Provider가 먼저 배포되어야만 Consumer를 테스트할 수 있는 구조가 아니라, 계약과 검증 결과를 별도로 공유할 수 있습니다. Pact Broker 공식 문서는 계약, 검증 결과, 배포 버전을 함께 기록하고 배포 가능 여부를 판단하는 기능을 설명합니다. [Pact Broker](https://docs.pact.io/pact_broker)와 [Can I Deploy](https://docs.pact.io/pact_broker/can_i_deploy) 자료를 함께 보면 이 흐름을 이해하기 쉽습니다.

예를 들어 CI 단계에서 다음처럼 배포 가능 여부를 묻는 형태를 생각할 수 있습니다.

```bash
pact-broker can-i-deploy \
  --pacticipant order-service \
  --version $GIT_SHA \
  --to-environment production
```

이 명령 하나가 모든 위험을 제거해 주는 것은 아닙니다. 어떤 환경에 어떤 버전을 배포할지, Broker에 버전과 환경 정보를 얼마나 정확히 기록할지, 실패 시 배포를 막을지에 대한 운영 정책이 함께 필요합니다.

## 5. 일반적인 API 테스트와 함께 쓰기

Contract Testing은 기존 테스트를 대체하는 만능 테스트가 아닙니다. QA 관점에서는 테스트 목적을 나누는 것이 중요합니다.

| 테스트 종류 | 확인하는 질문 | 예시 |
| --- | --- | --- |
| 단위 테스트 | 함수의 규칙이 맞는가? | 금액 계산이 올바른가 |
| Contract Testing | 서비스 간 약속이 맞는가? | 필드명·타입·상태 코드가 호환되는가 |
| 통합 테스트 | 여러 구성요소가 함께 동작하는가? | 실제 DB와 메시지 브로커 연동 |
| E2E 테스트 | 사용자의 전체 흐름이 되는가? | 주문부터 결제 완료까지 |
| 부하 테스트 | 부하에서 성능 목표를 지키는가? | 동시 요청에서 지연시간 확인 |

예를 들어 결제 API의 응답 필드가 바뀌었는지 확인하는 데는 Contract Testing이 적합합니다. 하지만 결제 승인이라는 외부 시스템의 실제 동작, 데이터베이스 트랜잭션, 재시도와 중복 결제 방지는 별도의 통합·시나리오 테스트로 확인해야 합니다. Contract Testing을 도입한다고 해서 E2E를 모두 없애는 것이 아니라, E2E가 맡아야 할 범위를 줄여 피드백 속도와 유지보수성을 개선하는 방향이 현실적입니다.

## 6. QA가 계약 테스트를 설계할 때 볼 것

첫째, 소비자가 실제로 사용하는 요청과 응답을 기준으로 범위를 정합니다. API 문서의 모든 필드를 계약에 넣으면 변경에 지나치게 민감해질 수 있습니다. “이 필드가 없으면 소비자가 실패하는가?”를 기준으로 의존성을 구분하는 것이 좋습니다.

둘째, 성공 응답만 보지 않습니다. 인증 실패, 잘못된 요청, 리소스 없음, 중복 요청 등 소비자가 분기 처리하는 오류 응답도 계약의 대상이 될 수 있습니다. 예를 들어 주문 서비스가 결제 서비스의 `409 Conflict`를 재시도하지 않도록 설계했다면, 이 상태 코드와 오류 구조도 명시적인 상호작용으로 다룰 수 있습니다.

셋째, 상태 설정을 생각합니다. Provider 검증은 특정 데이터 상태에서 요청을 재생해야 합니다. “order-1001이 존재한다” 같은 provider state를 만들고, 검증 환경에서 동일한 조건을 준비해야 합니다. 테스트 데이터 준비가 불안정하면 계약 자체보다 검증 환경의 상태 때문에 실패할 수 있습니다.

넷째, 버전과 배포 환경을 연결합니다. 계약 파일만 저장하면 어떤 Consumer 버전과 Provider 버전의 조합이 검증되었는지 알기 어렵습니다. CI에서 커밋 SHA나 릴리스 버전을 기록하고, 실제 배포 환경과 연결해야 `Can I Deploy` 판단이 의미를 가집니다.

## 7. 한계와 적용 기준 Q&A

<section class="quick-answers"><p class="quick-label">한계와 적용 기준</p><div class="quick-answer"><h3>Q. Contract Testing만 통과하면 API가 안전하다고 볼 수 있나요?</h3><p>A. 아닙니다. 계약은 합의한 상호작용이 호환되는지 확인할 뿐입니다. 인증 정책, 성능, 데이터 정합성, 장애 복구, 외부 결제 승인 같은 품질 속성은 별도로 검증해야 합니다.</p></div><div class="quick-answer"><h3>Q. 모든 팀이 Pact Broker를 운영해야 하나요?</h3><p>A. 서비스와 팀이 적다면 Pact 파일을 단순한 방식으로 공유하는 것부터 시작할 수 있습니다. 여러 저장소와 배포 환경의 관계를 관리해야 할 때 Broker의 가치가 커집니다.</p></div><div class="quick-answer"><h3>Q. 레거시 API에도 적용할 수 있나요?</h3><p>A. 소비자가 실제로 사용하는 요청과 응답을 먼저 좁게 계약으로 표현할 수 있습니다. 다만 상태 준비가 어렵거나 응답이 비결정적이면 테스트 안정성을 확보하는 작업이 선행되어야 합니다.</p></div><div class="quick-answer"><h3>Q. 언제 도입을 검토하면 좋나요?</h3><p>A. 독립 배포하는 서비스가 늘고, API 변경으로 다른 팀의 테스트가 자주 깨지며, 전체 통합 환경을 만들기 어려운 조직이라면 우선순위가 높습니다. 반대로 단일 애플리케이션이나 변경 조정이 쉬운 작은 시스템에는 별도 도구가 과할 수 있습니다.</p></div></section>

## 마무리

Contract Testing은 API 전체를 한 번에 검증하는 방법이라기보다, 서비스 사이에서 실제로 사용되는 약속을 작고 빠르게 확인하는 방법입니다. Pact를 사용하면 Consumer가 기대하는 상호작용을 계약으로 만들고, Provider가 같은 계약을 실제 구현으로 만족하는지 CI에서 확인할 수 있습니다.

도입할 때는 먼저 하나의 호출 관계를 고르는 편이 좋습니다. 예를 들어 주문 서비스와 결제 서비스 사이에서 자주 깨지는 응답 필드 몇 개를 계약으로 표현하고, Consumer 테스트와 Provider 검증을 연결한 뒤, 배포 판단에 필요한 버전 정보를 추가하는 식입니다. 이후 오류 응답, 여러 환경, Broker 운영으로 범위를 넓힐 수 있습니다.

결국 중요한 것은 도구의 이름보다 테스트의 질문입니다. “서비스 전체가 완벽히 동작하는가?”와 “이 소비자가 기대하는 약속을 제공자가 지키는가?”는 서로 다른 질문입니다. 두 질문을 분리하면 QA는 빠른 계약 검증과 넓은 통합 검증을 각각 적절한 위치에 둘 수 있습니다.

<figure class="article-figure"><img src="{{ '/assets/images/contract-testing-feedback.svg' | relative_url }}" alt="Contract Testing이 API 변경을 검증하는 흐름"><figcaption>이미지 출처: ChatGPT 생성</figcaption></figure>

### 참고 자료

- [Pact 공식 문서](https://docs.pact.io/)
- [Pact가 동작하는 방식](https://docs.pact.io/getting_started/how_pact_works)
- [Pact Consumer 가이드](https://docs.pact.io/consumer)
- [Pact Broker 공식 문서](https://docs.pact.io/pact_broker)
- [Can I Deploy](https://docs.pact.io/pact_broker/can_i_deploy)
- [Pact Specification](https://docs.pact.io/implementation_guides/pact_specification)
- [Martin Fowler, Consumer-Driven Contracts](https://martinfowler.com/articles/consumerDrivenContracts.html)
