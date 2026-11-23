---
layout: post
title: "WireMock으로 외부 API를 가상화해 테스트하는 법: 스텁 매핑·장애 주입·호출 검증·상태 시나리오"
categories: [QA]
tags: [qa, wiremock, service-virtualization, api-testing, stub, fault-injection, integration-test, http]
description: "외부 결제·알림 API 같은 협력 시스템 때문에 흔들리는 테스트를 서비스 가상화로 안정시키는 방법을 정리합니다. HTTP 기초부터 WireMock의 스텁 매핑, 지연·연결 끊김 같은 장애 주입, 호출 검증, 상태 시나리오, 계약 테스트와의 역할 분담까지 실행 예시로 설명합니다."
---

## 먼저 답하기

### Q. 외부 API를 호출하는 코드는 어떻게 안정적으로 테스트하나요?

A. 결제 대행사, 문자 발송, 배송 조회처럼 우리가 통제할 수 없는 외부 서비스를 호출하는 코드는, 실제 서비스를 부르면 테스트가 느리고 불안정하며 비용이나 부작용까지 생깁니다. 이때 쓰는 방법이 **서비스 가상화(service virtualization)** 입니다. 실제 서비스 대신 같은 HTTP 주소와 형식으로 응답해 주는 가짜 서버를 띄우고, 우리 코드는 그 서버를 호출하게 합니다. 오픈소스 도구인 **WireMock**은 이 가짜 서버를 JSON 설정(스텁 매핑)이나 Java·REST 코드로 쉽게 만들게 해 줍니다. 핵심은 "어떤 요청이 오면 어떤 응답을 돌려줄지"를 미리 정해 두는 것이며, 덕분에 정상 응답뿐 아니라 느린 응답, 500 오류, 연결 끊김 같은 **실제로는 재현하기 어려운 상황**도 마음대로 만들 수 있습니다.

### Q. 가상 서버로 테스트하면 실제 연동도 보장되나요?

A. 보장하지 않습니다. 가상 서버는 "우리가 이해한 외부 서비스의 약속"을 흉내 낼 뿐이어서, 외부 서비스가 약속을 바꾸거나 우리의 이해가 틀렸다면 가짜는 계속 통과해도 운영에서는 실패합니다. 그래서 가상화 테스트는 우리 코드의 **방어 로직(재시도, 타임아웃, 오류 처리)** 을 검증하는 데 강하고, 외부와의 **형식 일치**는 계약 테스트나 별도의 소수 실연동 테스트로 보완해야 합니다. 이 글의 코드와 수치는 개념 설명을 위한 가정 예시이며, 특정 프로젝트에서 직접 운영하거나 측정한 결과가 아닙니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 읽는 데 필요한 사전 개념을 밑바닥부터 쌓습니다. HTTP 요청·응답의 구조에서 시작해, 테스트가 외부 의존성 때문에 흔들리는 이유와 테스트 대역, 타임아웃·재시도 같은 장애 대응 개념, 그리고 서비스 가상화와 계약의 관계로 이어집니다. 각 소절 끝에 본문의 어느 절에서 쓰이는지 적었고, 마지막 표로 연결을 정리했습니다.

### HTTP 요청과 응답의 구조

**HTTP(HyperText Transfer Protocol)** 는 클라이언트가 서버에 요청(request)을 보내고 서버가 응답(response)을 돌려주는 규칙입니다. 요청은 메서드(`GET`, `POST` 등), 경로(`/v1/payments/123`), 쿼리 문자열(`?currency=KRW`), 헤더(`Content-Type: application/json` 같은 부가 정보), 본문(body)으로 이루어집니다. 응답은 상태 코드(200 성공, 404 없음, 500 서버 오류 등), 헤더, 본문으로 이루어집니다. 식당에 비유하면 요청은 주문서이고 응답은 나온 요리입니다.

다음처럼 `curl`로 직접 요청을 보내 보면 구조가 눈에 보입니다. `-i`는 응답 헤더도 함께 보여 주는 옵션입니다.

```bash
curl -i -X POST http://localhost:8080/v1/payments \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"A-1001","amount":15000}'
```

이 구조를 알아야 하는 이유는, WireMock의 모든 설정이 "요청의 어떤 부분이 이러하면(매칭), 응답의 이런 부분을 돌려준다"로 이루어지기 때문입니다. 이 개념은 아래 「스텁 매핑 만들기」 절에서 요청 매칭과 응답 정의로, 「호출 검증」 절에서 우리 코드가 보낸 요청을 확인하는 기준으로 쓰입니다.

### 테스트가 외부 의존성 때문에 흔들리는 이유

테스트 대상 코드가 다른 시스템(데이터베이스, 외부 API, 메시지 큐)을 호출하면, 그 시스템의 상태가 테스트 결과에 섞여 들어옵니다. 외부 서비스가 점검 중이거나, 네트워크가 느리거나, 같은 테스트 계정을 여러 사람이 동시에 쓰거나, 호출 횟수에 요금·제한이 걸려 있으면 코드는 그대로인데 결과가 달라집니다. 이런 테스트를 **불안정(flaky)한 테스트**라고 부릅니다. 외부 호출이 실제로 돈을 결제하거나 문자를 발송한다면 부작용도 큽니다.

또 하나의 문제는 **재현성**입니다. "외부 서비스가 3초 뒤에 응답한다"거나 "응답 도중 연결이 끊긴다"는 상황은 실제 서비스에서는 마음대로 만들 수 없습니다. 그래서 장애 대응 코드는 테스트하지 못한 채 운영에 나가기 쉽습니다. 이 개념은 아래 「왜 서비스 가상화가 필요한가」 절에서 동기로, 「장애 주입: 지연과 연결 끊김」 절에서 실제로 재현해 보는 대상으로 쓰입니다.

### 테스트 대역: 스텁, 목, 페이크

**테스트 대역(test double)** 은 테스트에서 실제 의존성을 대신하는 가짜 객체를 통틀어 부르는 말입니다. 마틴 파울러의 정리에 따르면 대표적으로 **스텁(stub)** 은 미리 정해 둔 응답을 돌려주는 대역, **목(mock)** 은 어떤 호출이 있었는지 기대를 걸어 두고 검증하는 대역, **페이크(fake)** 는 단순하지만 실제로 동작하는 대체 구현(메모리 DB 등)입니다. 영화 촬영에 비유하면 스텁은 정해진 대사만 하는 엑스트라, 목은 "이 장면에서 이 동작을 했는가"를 체크하는 감독 보조입니다.

코드 안에서 객체를 바꿔치기하는 단위 테스트의 대역과 달리, WireMock은 **네트워크 경계 바깥**에서 HTTP 서버로 대역을 만듭니다. 우리 코드는 평소처럼 HTTP 클라이언트로 요청을 보내므로 직렬화, 헤더, 타임아웃 같은 실제 HTTP 처리 경로까지 함께 검증됩니다. 이 개념은 아래 「스텁 매핑 만들기」 절에서 스텁 역할로, 「호출 검증」 절에서 목 역할로 쓰입니다.

### 타임아웃, 재시도, 멱등성

**타임아웃(timeout)** 은 응답을 얼마나 기다릴지의 한도이고, **재시도(retry)** 는 실패했을 때 같은 요청을 다시 보내는 정책입니다. 재시도에는 위험이 있습니다. 첫 요청이 사실은 성공했는데 응답만 늦었다면 재시도가 결제를 두 번 일으킬 수 있습니다. 이를 막는 성질이 **멱등성(idempotency)** 입니다. 같은 요청을 여러 번 보내도 결과가 한 번 보낸 것과 같도록 `Idempotency-Key` 같은 헤더로 요청을 식별하는 방식이 흔합니다. 엘리베이터 호출 버튼을 여러 번 눌러도 한 번 누른 것과 결과가 같은 것과 같은 원리입니다.

이 개념을 모르면 장애 주입 테스트에서 무엇을 확인해야 하는지 알 수 없습니다. 이 개념은 아래 「장애 주입: 지연과 연결 끊김」 절에서 타임아웃 설정 검증으로, 「상태 시나리오로 재시도 검증하기」 절에서 재시도 횟수와 멱등 키 확인으로 쓰입니다.

### 서비스 가상화와 계약

**서비스 가상화**는 의존하는 서비스의 동작을 흉내 내는 가상 서비스를 만들어 테스트하는 기법입니다. 한편 **계약(contract)** 은 "이 요청에는 이런 형식의 응답을 준다"는 서비스 간 약속입니다. 가상 서비스는 계약을 코드에서 흉내 낸 것이므로, 계약이 바뀌면 가상 서비스도 바뀌어야 합니다. 이 연결이 끊어지면 가짜만 통과하는 상태가 됩니다. 앞서 본 테스트 대역이 코드 안의 가짜라면 서비스 가상화는 네트워크 바깥의 가짜이고, 계약 테스트는 그 가짜가 진짜와 어긋나지 않는지 감시하는 장치입니다.

이 개념은 아래 「계약 테스트와 역할 분담」 절에서 가상화의 한계를 보완하는 방법으로, 「한계와 적용 기준 Q&A」 절에서 가짜가 진짜와 어긋날 때의 대응으로 쓰입니다.

### 기반 개념 연결 지도

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
| --- | --- | --- |
| HTTP 요청·응답 구조 | 스텁 매핑 만들기 | 요청 매칭 조건과 응답 정의의 단위 |
| HTTP 요청·응답 구조 | 호출 검증 | 우리 코드가 보낸 요청을 조건으로 확인 |
| 외부 의존성과 불안정 테스트 | 왜 서비스 가상화가 필요한가 | 가상화의 동기 |
| 외부 의존성과 불안정 테스트 | 장애 주입: 지연과 연결 끊김 | 재현하기 어려운 상황을 만들어 보는 대상 |
| 테스트 대역(스텁·목) | 스텁 매핑 만들기 | 정해진 응답을 주는 스텁 역할 |
| 테스트 대역(스텁·목) | 호출 검증 | 호출 여부를 검증하는 목 역할 |
| 타임아웃·재시도·멱등성 | 장애 주입: 지연과 연결 끊김 | 타임아웃 설정이 실제로 동작하는지 확인 |
| 타임아웃·재시도·멱등성 | 상태 시나리오로 재시도 검증하기 | 실패 후 성공 순서와 멱등 키 확인 |
| HTTP 요청·응답 구조 | 요청 매칭을 정교하게 쓰는 기준 | 요청 요소별 매칭 선택 |
| 서비스 가상화·계약 | 제공자의 API 명세에서 스텁을 만드는 흐름 | 명세 기반으로 스텁을 만들어 가짜와 진짜의 거리를 줄임 |
| 서비스 가상화·계약 | 계약 테스트와 역할 분담 | 가짜와 진짜의 어긋남을 보완하는 방법 |

## 왜 서비스 가상화가 필요한가

앞서 기반 기술에서 본 외부 의존성 문제는 세 가지 비용으로 나타납니다. 첫째 **속도**입니다. 외부 호출이 한 건에 수백 밀리초씩 걸리면 수백 개의 테스트를 도는 CI가 느려집니다. 둘째 **안정성**입니다. 외부 서비스의 장애가 우리 테스트의 실패로 번집니다. 셋째 **상황 통제**입니다. 정상 응답은 재현하기 쉽지만 타임아웃, 5xx, 잘못된 형식의 응답은 실제 서비스로 재현할 수 없습니다. 서비스 가상화는 이 셋을 해결합니다.

그림으로 보면 아래와 같습니다. 운영에서는 우리 서비스가 실제 외부 API를 호출하지만, 테스트에서는 같은 클라이언트 코드가 `base URL`만 바뀌어 WireMock을 호출합니다. 코드를 바꾸지 않고 접속 주소만 설정으로 바꾸는 것이 핵심입니다.

<figure class="article-figure"><img src="{{ '/assets/images/wiremock-service-virtualization-flow.svg' | relative_url }}" alt="운영에서는 서비스가 실제 외부 API를 호출하고 테스트에서는 같은 클라이언트가 WireMock 서버의 스텁 응답과 장애 주입, 호출 기록을 사용하는 구조"><figcaption>그림. 접속 주소만 바꿔 외부 API 자리에 WireMock을 두면 응답 스텁, 장애 주입, 호출 기록 검증을 한 곳에서 할 수 있다. 이미지 출처: 직접 제작</figcaption></figure>

| 구분 | 실제 외부 서비스 호출 | 단위 테스트 목(코드 안) | WireMock(네트워크 바깥) |
| --- | --- | --- | --- |
| HTTP 클라이언트·직렬화 검증 | 검증됨 | 검증 안 됨(건너뜀) | 검증됨 |
| 속도·안정성 | 느리고 외부 상태에 좌우 | 빠르고 안정적 | 빠르고 안정적 |
| 장애 상황 재현 | 사실상 불가 | 가능(코드 수준) | 가능(HTTP 수준) |
| 언어·프레임워크 의존 | 없음 | 해당 언어에 종속 | 언어와 무관(HTTP로 접근) |
| 외부와의 실제 일치 | 확인됨 | 확인 안 됨 | 확인 안 됨(계약 테스트로 보완) |

## WireMock 실행해 보기

WireMock은 Java로 만들어진 오픈소스(Apache License 2.0)입니다. 가장 간단한 사용법은 Docker 이미지로 독립 서버를 띄우는 것입니다. 아래 명령은 8080 포트로 서버를 띄우고, 현재 폴더의 `stubs` 디렉터리를 매핑으로 사용합니다. WireMock은 `mappings` 폴더의 JSON을 시작 시 읽고, `__files` 폴더의 파일을 응답 본문 파일로 씁니다.

```bash
mkdir -p stubs/mappings stubs/__files
docker run -d --name wm -p 8080:8080 \
  -v "$PWD/stubs:/home/wiremock" \
  wiremock/wiremock:latest
```

운영에 쓰는 재현성 있는 테스트라면 `latest` 대신 특정 버전 태그를 고정해야 합니다. 서버가 떴는지는 관리 API로 확인합니다. WireMock은 `/__admin` 경로 아래에 스텁 조회, 등록, 요청 기록 조회를 위한 REST API를 제공합니다.

```bash
curl -s http://localhost:8080/__admin/mappings | head
```

## 스텁 매핑 만들기

스텁 하나는 "요청 매칭 조건(request)"과 "응답 정의(response)"로 이루어집니다. 앞서 기반 기술에서 본 HTTP 요청의 메서드, 경로, 헤더, 본문이 매칭의 재료입니다. 아래는 결제 승인 API가 `POST /v1/payments`에 금액 정보를 받으면 승인 결과를 돌려주는 가상 스텁입니다. 파일명은 `stubs/mappings/payment-approve.json`이라고 가정합니다.

```json
{
  "request": {
    "method": "POST",
    "urlPath": "/v1/payments",
    "headers": { "Content-Type": { "contains": "application/json" } },
    "bodyPatterns": [
      { "matchesJsonPath": "$[?(@.amount > 0)]" }
    ]
  },
  "response": {
    "status": 201,
    "headers": { "Content-Type": "application/json" },
    "jsonBody": {
      "paymentId": "pay_0001",
      "status": "APPROVED"
    }
  }
}
```

`urlPath`는 쿼리 문자열을 제외한 경로가 일치하는지를 보고, `url`은 쿼리까지 정확히 일치하는지를 봅니다. 요청이 여러 스텁에 동시에 맞으면 `priority` 값이 작은(우선순위가 높은) 스텁이 선택되고, 같으면 **가장 나중에 등록된 스텁**이 이깁니다. 조건이 없는 넓은 스텁과 구체적인 스텁이 섞여 있을 때는 이 규칙을 알고 있어야 의도치 않은 응답을 피할 수 있습니다. 어느 스텁에도 맞지 않는 요청에는 404와 함께 가장 가까운 스텁 정보를 보여 주는 진단 메시지가 돌아오므로, 매칭이 안 될 때 원인을 찾기 쉽습니다.

이제 REST API로 스텁을 동적으로 등록하는 방법을 봅니다. 테스트 코드에서 시나리오마다 다른 응답을 쓰려면 이 방식이 더 편합니다.

```bash
curl -s -X POST http://localhost:8080/__admin/mappings \
  -H 'Content-Type: application/json' \
  -d '{
    "request": { "method": "GET", "urlPath": "/v1/payments/pay_0001" },
    "response": { "status": 200,
                  "headers": {"Content-Type": "application/json"},
                  "jsonBody": {"paymentId":"pay_0001","status":"APPROVED"} }
  }'

curl -i http://localhost:8080/v1/payments/pay_0001
```

응답 본문은 템플릿으로 요청 값을 반영해 동적으로 만들 수도 있습니다. 다만 템플릿이 복잡해지면 스텁이 곧 하나의 작은 구현체가 되어 유지 비용이 커지므로, 필요한 만큼만 쓰는 편이 좋습니다.

## 우리 코드에 연결하는 실습

이제 우리 서비스 코드를 가상 서버에 연결해 봅니다. 파이썬으로 결제 클라이언트와 `pytest` 테스트를 만들어 보겠습니다. 중요한 것은 클라이언트가 접속 주소를 하드코딩하지 않고 설정으로 받는 것입니다. 이렇게 해 두면 테스트에서는 WireMock 주소를, 운영에서는 실제 주소를 주입할 수 있습니다.

```python
# payment_client.py
import requests

class PaymentClient:
    def __init__(self, base_url, timeout=2.0):
        self.base_url = base_url
        self.timeout = timeout

    def approve(self, order_id, amount):
        r = requests.post(
            f"{self.base_url}/v1/payments",
            json={"orderId": order_id, "amount": amount},
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()["status"]
```

```python
# test_payment_client.py
import os
from payment_client import PaymentClient

BASE = os.environ.get("PAYMENT_BASE_URL", "http://localhost:8080")

def test_approve_returns_approved():
    client = PaymentClient(BASE)
    assert client.approve("A-1001", 15000) == "APPROVED"
```

```bash
PAYMENT_BASE_URL=http://localhost:8080 pytest -q test_payment_client.py
```

이 테스트는 실제 결제 서비스를 부르지 않으므로, 네트워크가 끊긴 환경이나 CI에서도 같은 결과를 냅니다. Java 프로젝트라면 JUnit 5용 `WireMockExtension`을 써서 테스트 안에서 서버를 띄우고 포트를 자동 할당받을 수 있습니다. 아래는 개념 예시입니다.

```java
@RegisterExtension
static WireMockExtension wm = WireMockExtension.newInstance()
    .options(wireMockConfig().dynamicPort())
    .build();

@Test
void approveReturnsApproved() {
    wm.stubFor(post(urlPathEqualTo("/v1/payments"))
        .willReturn(aResponse().withStatus(201)
            .withHeader("Content-Type", "application/json")
            .withBody("{\"paymentId\":\"pay_0001\",\"status\":\"APPROVED\"}")));

    PaymentClient client = new PaymentClient(wm.baseUrl());
    assertEquals("APPROVED", client.approve("A-1001", 15000));
}
```

동적 포트를 쓰면 병렬로 도는 테스트끼리 포트가 충돌하지 않습니다. 이는 CI에서 테스트를 병렬화할 때 특히 유용한 습관입니다.

## 장애 주입: 지연과 연결 끊김

가상화의 가장 큰 장점은 앞서 기반 기술에서 본 "재현하기 어려운 상황"을 만드는 것입니다. WireMock은 응답 지연과 네트워크 수준의 오류를 설정으로 지원합니다. 아래 스텁은 응답을 5초 뒤에 돌려주도록 해서, 우리 클라이언트의 2초 타임아웃이 제대로 동작하는지 확인합니다.

```json
{
  "request": { "method": "GET", "urlPath": "/v1/payments/slow" },
  "response": {
    "status": 200,
    "fixedDelayMilliseconds": 5000,
    "jsonBody": { "status": "APPROVED" }
  }
}
```

```python
import pytest, requests
from payment_client import PaymentClient

def test_timeout_is_applied():
    client = PaymentClient("http://localhost:8080", timeout=2.0)
    with pytest.raises(requests.exceptions.Timeout):
        requests.get(f"{client.base_url}/v1/payments/slow", timeout=client.timeout)
```

연결 자체가 비정상적으로 끊기는 상황은 `fault` 필드로 재현합니다. 공식 문서에는 `EMPTY_RESPONSE`(빈 응답), `MALFORMED_RESPONSE_CHUNK`(응답 도중 깨진 조각), `RANDOM_DATA_THEN_CLOSE`(무작위 데이터 후 연결 종료), `CONNECTION_RESET_BY_PEER`(상대가 연결을 리셋) 등이 정의되어 있습니다. 어떤 오류를 지원하는지는 사용하는 버전의 문서로 확인해야 합니다.

```json
{
  "request": { "method": "POST", "urlPath": "/v1/payments/reset" },
  "response": { "fault": "CONNECTION_RESET_BY_PEER" }
}
```

이런 테스트가 알려 주는 것은 "우리 코드가 예외를 삼키지 않고, 사용자에게 의미 있는 오류로 바꾸며, 불필요하게 오래 기다리지 않는가"입니다. 이 확인이 없으면 타임아웃이 설정되지 않은 클라이언트가 외부 서비스 지연 때문에 스레드를 모두 점유하는 사고를 테스트 단계에서 놓치기 쉽습니다.

## 상태 시나리오로 재시도 검증하기

"처음 두 번은 실패하고 세 번째에 성공"하는 외부 서비스를 흉내 내려면 **시나리오(scenario)** 라는 상태 기능을 씁니다. 같은 요청이라도 현재 상태에 따라 다른 응답을 주고, 응답 후 상태를 바꿀 수 있습니다. 앞서 기반 기술에서 본 재시도와 멱등성을 검증하기에 알맞습니다.

```json
[
  {
    "scenarioName": "retry-flow",
    "requiredScenarioState": "Started",
    "newScenarioState": "second-try",
    "request": { "method": "POST", "urlPath": "/v1/payments" },
    "response": { "status": 503 }
  },
  {
    "scenarioName": "retry-flow",
    "requiredScenarioState": "second-try",
    "newScenarioState": "third-try",
    "request": { "method": "POST", "urlPath": "/v1/payments" },
    "response": { "status": 503 }
  },
  {
    "scenarioName": "retry-flow",
    "requiredScenarioState": "third-try",
    "request": { "method": "POST", "urlPath": "/v1/payments" },
    "response": { "status": 201, "jsonBody": { "status": "APPROVED" } }
  }
]
```

이 설정에서 우리 클라이언트가 최대 3회 재시도하도록 구현되어 있다면 최종적으로 성공해야 하고, 최대 2회까지만 재시도한다면 실패해야 합니다. 테스트는 최종 결과와 함께 "총 몇 번 호출했는가"를 확인해야 하는데, 이는 다음 절의 호출 검증으로 합니다. 시나리오 상태는 서버에 남아 있으므로 테스트가 끝나면 초기화하는 것을 잊으면 안 됩니다.

```bash
# 시나리오 상태를 모두 Started로 되돌림
curl -s -X POST http://localhost:8080/__admin/scenarios/reset
```

## 호출 검증

스텁이 "받은 요청에 응답하는" 장치라면, 호출 검증은 "우리 코드가 올바른 요청을 보냈는가"를 확인하는 장치입니다. 앞서 기반 기술에서 본 목의 역할입니다. WireMock은 받은 모든 요청을 기록하고 이를 조회·집계하는 API를 제공합니다. 아래는 `POST /v1/payments`가 정확히 3번 호출되었는지 확인하는 예시입니다.

```bash
curl -s -X POST http://localhost:8080/__admin/requests/count \
  -H 'Content-Type: application/json' \
  -d '{"method":"POST","urlPath":"/v1/payments"}'
# 예시 출력: {"count":3}
```

요청 본문에 필요한 필드가 있는지, 멱등 키 헤더가 매번 같은 값으로 들어갔는지까지 조건으로 확인할 수 있습니다.

```bash
curl -s -X POST http://localhost:8080/__admin/requests/count \
  -H 'Content-Type: application/json' \
  -d '{"method":"POST","urlPath":"/v1/payments",
       "headers":{"Idempotency-Key":{"equalTo":"order-A-1001"}}}'
```

또한 어떤 스텁에도 맞지 않아 404가 난 요청은 따로 조회할 수 있어, 우리 코드가 의도하지 않은 경로를 호출했는지 점검할 수 있습니다.

```bash
curl -s http://localhost:8080/__admin/requests/unmatched
```

호출 검증에서 주의할 점은 **구현 세부에 과하게 묶이지 않는 것**입니다. 헤더 순서나 쿼리 파라미터 순서까지 검증하면 정상적인 리팩터링에도 테스트가 깨집니다. 외부 서비스의 약속에 해당하는 요소(경로, 필수 필드, 멱등 키)만 검증하는 편이 좋습니다.

## 요청 매칭을 정교하게 쓰는 기준

스텁이 너무 느슨하면 잘못된 요청도 통과시키고, 너무 엄격하면 정상적인 변경에도 테스트가 깨집니다. 앞서 기반 기술에서 본 HTTP 요청의 구성 요소별로 어떤 매칭을 쓰는지 정리하면 다음과 같습니다. 각 연산자의 정확한 이름과 동작은 공식 문서의 Request Matching 항목을 기준으로 확인해야 합니다.

| 요청 요소 | 자주 쓰는 매칭 | 쓰는 이유 | 주의할 점 |
| --- | --- | --- | --- |
| 메서드 | `GET`, `POST` 등 정확히 일치 | 같은 경로라도 동작이 다름 | `ANY`는 의도치 않은 호출을 통과시킴 |
| 경로 | `urlPath`(쿼리 제외), `urlPathPattern`(정규식) | 경로 변수가 있는 API 대응 | 정규식은 범위가 넓어지기 쉬움 |
| 쿼리 파라미터 | `queryParameters`에 `equalTo` 등 | 필터·페이지 조건 검증 | 순서에 의존하지 않도록 개별 지정 |
| 헤더 | `contains`, `equalTo` | 인증 토큰·멱등 키 확인 | 값 전체를 고정하면 토큰 갱신에 깨짐 |
| 본문 | `matchesJsonPath`, `equalToJson` | 필수 필드·금액 검증 | 전체 본문 일치는 필드 추가에 취약 |

실무 원칙은 **외부 서비스가 반드시 요구하는 것만 매칭하고, 나머지는 열어 두는 것**입니다. 예를 들어 결제 승인 요청이라면 경로와 메서드, 금액 필드의 존재, 멱등 키 헤더 정도를 조건으로 두고, 사용자 이름 같은 부가 필드는 매칭에서 제외합니다. 그러면 우리 코드가 필드를 하나 추가해도 스텁을 고칠 필요가 없습니다. 반대로 "금액이 0 이하이면 외부가 거절한다"는 약속은 조건으로 표현해, 금액 검증이 빠진 구현을 테스트가 잡아내게 할 수 있습니다.

```json
{
  "request": {
    "method": "POST",
    "urlPath": "/v1/payments",
    "headers": { "Idempotency-Key": { "matches": "order-[A-Z0-9-]+" } },
    "bodyPatterns": [
      { "matchesJsonPath": "$.orderId" },
      { "matchesJsonPath": "$[?(@.amount > 0)]" }
    ]
  },
  "response": { "status": 201, "jsonBody": { "status": "APPROVED" } }
}
```

위 스텁은 멱등 키 형식이 맞고 필수 필드가 있을 때만 승인합니다. 조건에 맞지 않으면 앞서 본 대로 404와 진단 메시지가 돌아오므로, 우리 코드가 멱등 키를 빠뜨렸을 때 바로 발견됩니다. 이처럼 스텁의 요청 조건은 **외부 계약을 코드로 옮긴 명세서**로 읽히게 쓰는 것이 좋습니다.

## 제공자의 API 명세에서 스텁을 만드는 흐름

제공자가 OpenAPI(REST API를 기계가 읽을 수 있게 기술하는 표준 명세) 문서를 공개한다면, 스텁을 사람이 처음부터 짜는 대신 명세의 경로·상태 코드·응답 예시를 출발점으로 삼을 수 있습니다. 이렇게 하면 스텁이 "우리가 상상한 응답"이 아니라 "제공자가 문서로 약속한 응답"에 가까워집니다. 흐름은 다음과 같습니다.

1. 명세에서 우리가 쓰는 엔드포인트만 골라 목록을 만듭니다. 쓰지 않는 엔드포인트까지 스텁으로 만들면 유지 비용만 늘어납니다.
2. 각 엔드포인트의 성공 응답 예시와 문서화된 오류 응답(400, 401, 402, 429, 5xx 등)을 스텁 파일로 옮깁니다.
3. 명세 파일의 버전을 스텁 폴더에 함께 기록해, 제공자가 명세를 갱신하면 어느 스텁이 영향을 받는지 비교할 수 있게 합니다.
4. 명세에 없는 동작(예: 응답 지연, 연결 끊김)은 우리 방어 로직 검증용으로 별도 폴더에 두고 "문서화되지 않은 가정"임을 이름으로 구분합니다.

```bash
# 스텁 폴더에 근거 명세 버전을 기록해 두는 간단한 규칙 예시
echo "source: provider-openapi v2.3.1 (2026-10-15)" > stubs/README.txt
git add stubs && git commit -m "test: align payment stubs with provider spec v2.3.1"
```

이 습관의 가치는 스텁이 틀렸을 때 원인을 추적할 수 있다는 점입니다. 운영에서 형식 불일치가 발견되면 "스텁이 어느 명세 버전에 맞춰져 있었는가"를 바로 확인하고, 제공자의 변경인지 우리의 오해인지를 구분할 수 있습니다.

## 테스트 격리와 운영 팁

여러 테스트가 같은 WireMock 서버를 공유하면 앞선 테스트의 스텁과 요청 기록이 뒤 테스트에 영향을 줍니다. 앞서 본 불안정한 테스트를 스스로 만드는 셈입니다. 다음 원칙을 권합니다.

- 테스트마다 시작 전에 스텁과 요청 기록을 초기화합니다. 관리 API의 `POST /__admin/reset`이 스텁, 요청 기록, 시나리오 상태를 모두 초기 상태로 되돌립니다.
- 스텁은 가능하면 테스트 안에서 등록해 "이 테스트가 어떤 외부 응답을 가정하는지"가 테스트 코드 안에 보이게 합니다. 파일 기반 매핑은 여러 테스트가 공유하는 기본 응답에만 씁니다.
- 병렬 테스트에는 테스트(또는 워커)마다 별도의 서버·동적 포트를 씁니다.
- 접속 주소는 환경 변수나 설정으로 주입합니다. 주소를 코드에 박으면 가상화가 불가능해집니다.

```bash
curl -s -X POST http://localhost:8080/__admin/reset
```

스텁이 많아져 관리가 어려워지면 **녹화(recording)** 기능으로 실제 서비스의 응답을 한 번 기록해 스텁 초안을 만드는 방법도 있습니다. 다만 기록된 응답에는 개인정보나 토큰이 섞일 수 있으므로 저장 전에 마스킹하고 검토해야 합니다.

## 계약 테스트와 역할 분담

앞서 기반 기술에서 본 대로 가상 서버는 "우리가 이해한 계약"입니다. 계약이 틀렸다면 가짜는 계속 통과합니다. 이 간극을 메우는 방법은 세 가지로 정리할 수 있습니다.

| 방법 | 무엇을 확인하나 | 비용 | 적합한 용도 |
| --- | --- | --- | --- |
| 서비스 가상화(WireMock) | 우리 코드의 요청 구성과 방어 로직 | 낮음 | 정상·오류·지연 상황 재현 |
| 소비자 주도 계약 테스트 | 가짜 응답이 제공자의 실제 약속과 일치 | 중간 | 서비스 간 형식 불일치 방지 |
| 소수의 실연동 테스트 | 실제 인증·네트워크·환경 구성 | 높음 | 배포 전 최종 점검, 야간 실행 |

권장 구성은 대부분의 시나리오를 WireMock으로 빠르게 돌리고, 계약 테스트로 가짜의 형식을 지속적으로 검증하며, 실연동은 핵심 경로 몇 개만 낮은 빈도로 확인하는 것입니다. 제공자가 공개하는 OpenAPI 명세가 있다면 그 명세에서 응답 예시를 가져와 스텁을 만들고, 명세가 바뀌면 스텁도 함께 점검하는 흐름을 만들 수 있습니다.

## 업무 예시: 주문 서비스의 결제 연동 테스트

가정 시나리오입니다. 주문 서비스가 외부 결제 API를 호출해 승인받고, 실패 시 최대 3회까지 재시도하며, 끝내 실패하면 주문을 `PAYMENT_FAILED`로 표시합니다. 결제사는 샌드박스를 제공하지만 하루 호출 횟수 제한이 있고, 가끔 느려져 CI가 불안정합니다.

**1단계: 정상 경로.** 승인 응답 스텁을 등록하고 주문이 `PAID`로 바뀌는지 확인합니다.

**2단계: 비즈니스 오류.** 잔액 부족 같은 4xx 응답(예: 402)에는 재시도하지 않고 즉시 `PAYMENT_FAILED`로 끝나야 합니다. 호출 검증으로 호출 횟수가 1회인지 확인합니다.

**3단계: 일시 오류.** 503이 두 번 이어지다 성공하는 시나리오를 만들고, 최종적으로 `PAID`가 되며 호출 횟수가 3회, 모든 요청의 `Idempotency-Key`가 같은지 확인합니다.

**4단계: 지연과 끊김.** 응답 지연이 클라이언트 타임아웃을 넘을 때와 연결이 리셋될 때, 주문 서비스가 스레드를 오래 점유하지 않고 정해진 시간 안에 실패 처리하는지 확인합니다.

**5단계: 계약 점검.** 결제사가 제공하는 API 명세 변경 알림이 있다면 스텁의 응답 필드와 비교하고, 배포 파이프라인의 야간 작업으로 샌드박스에 대한 실연동 스모크 테스트 1~2건을 돌립니다.

이렇게 나누면 CI에서 도는 테스트는 모두 외부 상태와 무관해지고, 실제 외부와의 연결은 별도 경로로 관리됩니다. 위 단계는 개념을 보여 주는 가정이며 특정 프로젝트의 측정 결과가 아닙니다.

## 도입 전 점검 체크리스트

- 클라이언트의 접속 주소를 설정으로 주입할 수 있는가
- 스텁을 테스트 코드 안에서 등록해 가정이 눈에 보이는가
- 각 테스트가 시작 전에 스텁·기록·시나리오 상태를 초기화하는가
- 정상 경로 외에 4xx, 5xx, 지연, 연결 끊김을 각각 하나 이상 검증하는가
- 호출 검증이 외부 서비스의 약속(경로, 필수 필드, 멱등 키)에 한정되어 있는가
- 가짜와 진짜의 어긋남을 감시할 계약 테스트 또는 실연동 점검이 있는가
- Docker 이미지나 라이브러리 버전을 고정해 재현 가능한가
- 녹화한 응답에서 개인정보와 비밀을 제거했는가

## 한계와 적용 기준 Q&A

### Q. WireMock 테스트가 모두 통과하면 외부 연동은 안심해도 되나요?

A. 안심할 수 없습니다. 가짜가 통과시키는 것은 "우리가 이해한 계약에 대한 우리 코드의 반응"뿐입니다. 외부 서비스가 필드 이름을 바꾸거나 인증 방식을 바꾸어도 가짜는 그대로 통과합니다. 그래서 계약 테스트나 소수의 실연동 점검으로 가짜를 지속해서 검증해야 합니다.

### Q. 스텁이 점점 늘어나 유지보수가 어렵습니다.

A. 스텁이 많아지는 것은 테스트가 외부 응답의 세부에 과하게 묶여 있다는 신호일 수 있습니다. 응답 본문은 테스트에 필요한 필드만 담고, 공통 응답은 한 곳에서 만들어 재사용하세요. 템플릿으로 복잡한 로직을 구현하고 있다면 스텁이 작은 서비스가 되어 가는 것이므로, 그 시점에 계약 테스트 도구나 제공자가 주는 샌드박스를 쓰는 편이 나은지 다시 검토합니다.

### Q. HTTP가 아닌 프로토콜(gRPC, 메시지 큐, 데이터베이스)도 가상화할 수 있나요?

A. WireMock의 핵심 기능은 HTTP입니다. gRPC나 메시지 큐 같은 프로토콜은 확장이나 별도 도구가 필요하며 지원 범위는 버전과 확장에 따라 다릅니다. 데이터베이스는 가상화보다 테스트 컨테이너로 실제 DB를 띄우는 편이 흔하므로, 대상에 맞는 도구를 선택해야 합니다.

### Q. 단위 테스트의 목(mock) 라이브러리로 충분하지 않나요?

A. 코드 안에서 HTTP 클라이언트 객체를 목으로 바꾸면 요청 직렬화, 헤더, 타임아웃, 실제 응답 파싱 같은 경로가 모두 건너뛰어집니다. 외부 호출을 감싼 어댑터 한 겹을 단위 테스트로 빠르게 검증하고, 그 어댑터 자체는 WireMock으로 HTTP 수준에서 검증하는 두 겹 구성이 효과적입니다. 어느 한쪽만 쓰는 것보다 서로 다른 결함을 잡을 수 있습니다.

### Q. 스텁 응답을 운영 데이터 그대로 복사해 써도 되나요?

A. 권하지 않습니다. 운영 응답에는 고객 이름, 연락처, 토큰, 내부 식별자가 섞여 있을 수 있어 저장소에 커밋하는 순간 유출 경로가 됩니다. 스텁에는 형식만 같은 가짜 값을 쓰고, 녹화 기능으로 만든 초안은 반드시 마스킹과 리뷰를 거친 뒤 저장하세요.

### Q. 언제 쓰지 않는 편이 좋은가요?

A. 외부 서비스가 제공자의 공식 테스트 더블이나 안정적인 샌드박스를 이미 제공하고 호출 비용도 없다면, 굳이 직접 스텁을 만들 필요가 없을 수 있습니다. 또한 응답이 극히 단순하고 호출이 한두 곳뿐이라면 단위 테스트의 목으로 충분합니다. 반대로 장애 상황을 반드시 검증해야 하거나, 외부 서비스가 느리고 호출 제한이 있다면 가상화의 효과가 큽니다.

## 마무리

서비스 가상화는 외부 의존성 때문에 흔들리는 테스트를 안정시키고, 실제로는 만들기 어려운 지연과 오류 상황을 마음대로 재현하게 해 줍니다. WireMock은 스텁 매핑, 장애 주입, 상태 시나리오, 호출 검증을 HTTP 수준에서 한곳에 모아 줍니다. 다만 가짜는 우리의 이해를 흉내 낸 것이므로 계약 테스트와 소수의 실연동 점검으로 계속 확인해야 합니다. 지금 다루는 코드에서 외부 API를 부르는 곳 하나를 골라, 접속 주소를 설정으로 빼고 정상 응답 하나와 타임아웃 하나를 WireMock으로 검증하는 것부터 시작해 보세요.

<h3 class="references-heading">참고 자료</h3>

- [WireMock 공식 문서](https://wiremock.org/docs/)
- [WireMock: Stubbing](https://wiremock.org/docs/stubbing/)
- [WireMock: Request Matching](https://wiremock.org/docs/request-matching/)
- [WireMock: Simulating Faults](https://wiremock.org/docs/simulating-faults/)
- [WireMock: Verifying](https://wiremock.org/docs/verifying/)
- [WireMock: Stateful Behaviour](https://wiremock.org/docs/stateful-behaviour/)
- [WireMock: Running as a Standalone Process](https://wiremock.org/docs/standalone/)
- [Martin Fowler: Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html)
- [Martin Fowler: Test Double](https://martinfowler.com/bliki/TestDouble.html)
- [Martin Fowler: Testing Strategies in a Microservice Architecture](https://martinfowler.com/articles/microservice-testing/)
