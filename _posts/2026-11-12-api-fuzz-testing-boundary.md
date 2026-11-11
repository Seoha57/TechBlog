---
layout: post
title: "API 퍼즈 테스트를 설계하는 법: 입력 경계·상태·보안 오류를 안전하게 찾기"
categories: [QA]
tags: [qa, api, fuzz-testing, security-testing, boundary-testing, automation]
description: "API 퍼즈 테스트가 무엇인지부터 입력 생성, 인증과 상태 관리, 안전 장치, CI 적용 기준까지 실무 예시로 설명합니다."
---

## 먼저 답하기

### Q. API 퍼즈 테스트는 무작위 문자열을 많이 보내는 테스트인가요?

A. 출발점은 맞지만 전부는 아닙니다. 퍼즈 테스트(fuzz testing)는 예상하지 못한 입력을 만들어 API가 예외·오류 응답·자원 고갈·권한 우회를 일으키지 않는지 찾는 검증 방법입니다. 효과적인 퍼즈 테스트는 무작위 값만 던지지 않고, API의 타입·길이·형식·상태 전이·인증 조건을 이해한 뒤 정상 요청을 조금씩 변형합니다. 그래야 단순한 400 Bad Request가 아니라 실제로 서버가 잘못 처리할 수 있는 경계를 찾을 수 있습니다.

### Q. 단위 테스트와 OpenAPI 검증이 있는데 별도로 필요한가요?

A. 필요할 수 있습니다. 단위 테스트는 개발자가 예상한 분기와 규칙을 빠르게 확인하고, OpenAPI 검증은 문서에 적은 요청·응답 형식을 검사합니다. 반면 퍼즈 테스트는 사람이 미처 사례로 쓰지 못한 조합, 길이가 매우 긴 값, Unicode와 인코딩 경계, 순서가 다른 호출을 탐색합니다. 세 방법은 경쟁하지 않습니다. 빠른 단위 테스트와 명세 검증을 기본으로 두고, 입력을 외부에서 많이 받거나 오류가 보안·금전·데이터 손상으로 이어질 수 있는 API에 퍼즈 테스트를 더하는 방식이 현실적입니다.

## 먼저 알아둘 기반 기술

### HTTP API와 입력 검증

HTTP(Hypertext Transfer Protocol) API는 클라이언트가 URL, 메서드, header, query parameter, request body를 보내고 서버가 status code와 body를 돌려주는 경계입니다. 예를 들어 `POST /orders`는 JSON body로 상품과 수량을 받고, 인증 header로 호출자를 식별할 수 있습니다. 입력 검증(input validation)은 이 경계에서 타입·필수 여부·범위·형식을 확인해 잘못된 데이터를 거절하는 처리입니다. 숫자여야 할 수량에 문자열을 넣거나, 이메일 형식이 아닌 값을 보내면 보통 400 계열 오류로 안전하게 끝나야 합니다.

하지만 검증은 한 줄의 정규식으로 끝나지 않습니다. JSON parser가 중첩 배열을 얼마나 깊게 처리하는지, 파일 업로드의 content type과 실제 내용이 일치하는지, query parameter가 여러 번 들어오면 어느 값을 쓰는지, URL decoding 뒤 값이 어떻게 바뀌는지도 경계가 됩니다. 퍼즈 테스트는 이 경계에서 서버가 입력을 예측 가능하게 거절하는지, 예외 stack trace나 민감 정보를 응답하지 않는지 확인합니다.

### 경계값, property, oracle

경계값(boundary value)은 허용 길이 100자의 바로 전·같은 값·바로 다음 값처럼 오류가 생기기 쉬운 지점입니다. property는 특정 결과값 하나가 아니라 항상 지켜야 하는 성질입니다. 예를 들어 어떤 잘못된 주문 수량이 오더라도 서버는 500 오류로 내부 예외를 노출하지 않고, 데이터베이스에 음수 재고를 만들지 않아야 한다는 규칙이 property가 될 수 있습니다. oracle은 테스트 결과가 옳은지 판단하는 기준입니다. 퍼즈 테스트는 입력이 많으므로 모든 입력의 정답 body를 사람이 쓰기 어렵습니다. 대신 "응답 시간은 제한을 넘지 않는다", "오류 body에 비밀키가 없다", "상태 변경 API는 같은 요청을 반복해도 결제가 중복되지 않는다" 같은 oracle을 둡니다.

## 퍼즈 테스트가 등장한 이유

일반적인 API 테스트는 대표 정상 사례와 알려진 오류 사례를 중심으로 작성합니다. 이는 읽기 쉽고 회귀를 막는 데 훌륭하지만, 사람이 가능한 조합을 모두 나열할 수는 없습니다. 이름 필드만 해도 빈 문자열, 공백, 제어 문자, 여러 언어 문자, 매우 긴 문자열, 잘못된 UTF-8, SQL 구문처럼 보이는 문자열, 유사한 유니코드 문자가 있습니다. 필드 두 개가 함께 있을 때만 발생하는 오류나, 인증된 상태에서만 지나가는 handler의 오류도 사례 목록만으로 놓칠 수 있습니다.

과거에는 입력 이상으로 프로세스가 중단되는 결함을 찾는 데 퍼즈 테스트가 많이 쓰였습니다. 웹 API에서는 crash뿐 아니라 예외 처리 누락, validation 우회, request parsing의 과도한 CPU·메모리 사용, 잘못된 상태 코드, 데이터 손상, 권한 확인의 순서 오류도 중요한 대상입니다. 따라서 목적은 "이상한 요청을 많이 보내기"보다 "외부 입력이 어떤 모양이어도 서비스가 정의된 안전한 방식으로 행동하는가"를 탐색하는 데 있습니다.

## 테스트 대상을 먼저 좁히는 방법

모든 endpoint에 최대 강도로 퍼즈 테스트를 걸면 CI가 느려지고, 테스트 환경 데이터가 망가지며, 결과를 읽기 어려워집니다. 먼저 외부 입력량과 실패 영향으로 대상을 고릅니다. 회원 가입·로그인·파일 업로드·검색 조건·가격 계산·쿠폰 적용·관리자 권한 변경처럼 입력이 다양하거나 민감한 API가 우선입니다. 내부 health check나 단순 조회 endpoint는 기본 schema 검증만으로 충분할 수 있습니다.

각 endpoint를 표로 정리할 때는 요청 위치, 허용 타입, 상태 변경 여부, 인증 역할, rate limit, 중요한 금지 결과를 적습니다. 예를 들어 `PATCH /users/{id}`는 path의 `id`, JSON body의 변경 field, authorization header, 현재 사용자의 역할이 입력입니다. 금지 결과는 다른 사용자의 프로필 변경, password hash의 응답 노출, 예상 밖 500, 장시간 응답 같은 것으로 정할 수 있습니다. 이 목록이 있어야 퍼즈 도구의 결과 중 실제 위험과 단순 validation 실패를 구분할 수 있습니다.

## 입력 생성: 완전 무작위보다 구조를 유지한 변형

구조를 모르는 완전 무작위 바이트는 parser의 앞부분에서 대부분 거절됩니다. JSON API라면 정상 요청 fixture를 seed로 만들고 한 필드씩 변형하는 편이 유용합니다. 문자열에는 빈 값·공백·최대 길이·최대 길이 초과·다국어·줄바꿈·제어 문자·유사 문자·예상하지 못한 escape를 넣습니다. 숫자에는 0, 음수, 최댓값 근처, 소수, 큰 지수 표기, 문자열 숫자를 넣습니다. 배열에는 빈 배열, 중복 원소, 수천 개 원소, 순서 변경을 넣고, object에는 알 수 없는 field·필수 field 누락·null·중첩 object를 시도합니다.

형식을 일부 유지하는 이유는 business logic까지 도달하기 위해서입니다. 예컨대 주문 생성 API에서 JSON 문법 자체를 깨면 parser만 검증하지만, 정상 상품 ID와 비정상 수량을 조합하면 재고·가격·권한 분기까지 통과할 수 있습니다. OpenAPI Specification(OAS)은 경로, parameter, schema, 예시를 기계가 읽을 수 있게 표현하므로 seed와 변형 후보를 만드는 출발점이 될 수 있습니다. 다만 명세가 실제 구현과 다르다면 도구가 잘못된 실패를 대량으로 낼 수 있으므로, 먼저 대표 정상 요청이 명세와 실제에서 모두 통과하는지 확인합니다.

## 상태와 인증을 빼면 중요한 결함을 놓친다

많은 API는 한 요청만으로 의미가 완성되지 않습니다. 장바구니를 만든 뒤 결제를 시도하고, 결제 후 취소하고, 이미 취소한 주문을 다시 취소하는 흐름에는 상태 전이가 있습니다. 퍼즈 테스트가 매 요청마다 새 데이터와 새 세션을 만들면 "이미 취소됨"이나 "다른 사용자의 주문" 같은 분기를 탐색할 수 없습니다. 그래서 읽기 전용 fuzz와 상태 기반(stateful) fuzz를 구분합니다. 후자는 준비 단계, 실행 단계, 정리 단계를 명확히 두고 idempotency key와 테스트 데이터 식별자를 사용합니다.

인증도 같은 원칙입니다. 인증 없음, 일반 사용자, 다른 테넌트 사용자, 관리자처럼 역할을 나눠야 권한 우회를 찾을 수 있습니다. 그러나 실제 사용자 token이나 production credential을 테스트 파일에 넣어서는 안 됩니다. 격리된 테스트 계정과 짧은 수명의 credential을 사용하고, 로그에는 token 값이 아닌 역할 이름과 request ID만 남깁니다. 테스트가 저장한 데이터는 실행 뒤 제거하거나 환경 전체를 폐기할 수 있어야 합니다.

## 안전 장치 없이 production을 두드리지 않기

퍼즈 테스트는 의도적으로 비정상적인 대량 요청을 보내므로 production endpoint를 무심코 대상으로 삼으면 rate limit, 감사 로그, 고객 데이터, 외부 결제에 영향을 줄 수 있습니다. 기본 실행 대상은 production과 분리된 환경이어야 하며, 외부 provider는 sandbox나 test double로 대체합니다. 결제·메일·SMS처럼 비용이나 실제 행동이 발생하는 integration에는 network egress 차단, 허용 host 목록, 가짜 계정 같은 이중 안전 장치를 둡니다.

요청 횟수와 동시성도 제한합니다. 초기에 endpoint당 수십 또는 수백 case로 시작하고, timeout을 짧게 두며, 5xx나 예상하지 못한 상태가 반복되면 자동 중지하도록 설정합니다. 이 제한은 결함을 숨기기 위한 것이 아니라 테스트가 환경을 망가뜨리지 않게 하는 장치입니다. 실행 전후로 테스트 데이터의 개수, queue 길이, 외부 호출 횟수를 확인하면 cleanup 누락을 빨리 찾을 수 있습니다.

## 업무 예시: 쿠폰 적용 API의 입력 경계 찾기

쇼핑 서비스에 `POST /orders/{orderId}/coupon` API가 있다고 가정해 봅시다. 정상 요청은 쿠폰 코드와 idempotency key를 보내며, 서버는 주문 소유자·쿠폰 만료·최소 금액·중복 적용 여부를 확인합니다. 기본 단위 테스트는 만료 쿠폰과 정상 쿠폰을 각각 확인할 수 있습니다. 퍼즈 테스트에서는 주문 ID에 다른 테넌트의 값, coupon code에 빈 값과 최대 길이 초과 값, body에 중복 field, idempotency key에 같은 값 반복과 서로 다른 값 반복을 넣어 봅니다.

oracle은 단순히 2xx 여부가 아닙니다. 다른 사용자의 주문 금액은 바뀌지 않아야 하고, 동일 key의 재시도는 할인 금액을 두 번 적용하지 않아야 하며, 잘못된 입력은 validation 오류로 끝나야 하고, 500 응답에는 SQL·stack trace·내부 쿠폰 규칙이 노출되지 않아야 합니다. 데이터베이스 상태를 직접 확인할 수 있다면 테스트 전후 주문별 할인 row 수와 합계를 비교할 수 있습니다. 다만 테스트가 implementation detail에 지나치게 묶이지 않도록, 사용자에게 중요한 불변식부터 assertion으로 만들면 좋습니다.

발견된 실패는 재현 가능한 최소 입력으로 줄입니다. 원본 fuzz run이 수천 요청이었다면, 문제가 난 request body·header·순서·seed·도구 version을 보관하고 불필요한 변형을 제거합니다. 그렇게 만든 작은 fixture는 일반 회귀 테스트에 추가합니다. 퍼즈 테스트는 새로운 결함을 탐색하고, 축소된 regression test는 같은 결함이 다시 들어오는 것을 빠르게 막는 역할을 합니다.

## CI에서 실행하는 층을 나누기

모든 pull request에서 긴 fuzz campaign을 실행하면 개발 피드백이 느려질 수 있습니다. 보통은 세 층으로 나눕니다. 첫째, PR에서는 seed 기반의 짧은 deterministic set과 대표 boundary case를 실행합니다. 둘째, nightly 또는 배포 후보에서는 더 많은 mutation과 상태 조합을 실행합니다. 셋째, 큰 parser·인증·주문 흐름 변경 전에는 격리 환경에서 더 긴 campaign을 수행합니다. 같은 seed를 기록하면 실패를 재현할 수 있고, seed를 주기적으로 바꾸면 탐색 폭을 넓힐 수 있습니다.

결과 보고에는 실행 수만 쓰지 말고 endpoint, 입력 범주, status code 분포, timeout 수, 예상하지 못한 5xx, 생성·정리한 테스트 데이터, 재현 seed를 넣습니다. 400이 많다고 실패는 아닙니다. 거절되어야 할 입력이 안전하게 거절된 것일 수 있습니다. 반대로 200이 많아도 권한 없는 변경이 성공했다면 심각합니다. 팀이 사전에 기대 응답을 합의해야 대시보드의 숫자를 오해하지 않습니다.

## 실패를 분류하고 수정 우선순위를 정하기

퍼즈 결과는 보통 네 가지로 분류할 수 있습니다. 첫째, 명세대로 4xx를 반환한 정상 거절입니다. 둘째, 테스트 데이터나 환경 불안정 때문에 생긴 noise입니다. 셋째, 문서와 실제 동작이 달라 계약을 정리해야 하는 경우입니다. 넷째, 예외·권한 우회·데이터 손상·자원 고갈처럼 코드 또는 설정을 고쳐야 하는 결함입니다. 이 분류를 하지 않으면 많은 입력을 보냈다는 사실만 남고 품질 개선으로 이어지지 않습니다.

특히 5xx는 원인을 좁혀야 합니다. 단순히 500을 400으로 바꾸는 것이 정답은 아닙니다. validation이 누락됐는지, downstream timeout을 잘못 번역했는지, null 처리에서 예외가 났는지, 너무 큰 입력을 제한 없이 처리했는지 로그와 trace를 함께 봅니다. 오류 응답을 바꾼 뒤에는 동일 최소 fixture와 정상 요청을 모두 다시 확인합니다. 보안 영향이 의심되면 재현 입력을 넓게 공유하지 않고 접근을 제한하며, 비밀 정보가 로그에 남았는지도 점검합니다.

## Corpus를 쌓고 최소 재현 사례로 줄이는 방법

퍼즈 테스트의 입력 모음은 corpus라고 부른다. 처음부터 거대한 corpus를 만들 필요는 없다. API 문서의 정상 예시, 실제 장애를 개인정보 없이 정리한 사례, 과거 bug ticket의 request, 공개 표준에서 정의한 경계 문자를 작은 seed 집합으로 만든다. 중요한 것은 각 seed가 왜 존재하는지 설명할 수 있는 것이다. 예를 들어 빈 배열은 항목이 최소 하나여야 하는 규칙을, 두 번 반복된 query parameter는 framework의 파싱 정책을, 최대 길이 문자열은 저장소와 validation 경계를 확인한다. 설명 없는 대용량 입력 묶음은 실패가 났을 때 원인을 찾기 어렵다.

실패를 발견하면 그 요청을 가능한 한 작게 줄이는 shrinking 과정이 필요하다. 30개 field와 긴 배열을 가진 JSON에서 실패했다면 field를 하나씩 빼고, 문자열 길이를 줄이고, 호출 순서를 단순화해도 같은 오류가 나는지 확인한다. 최소 사례가 되어야 개발자가 결함을 재현하고 수정할 수 있으며, 이후 빠른 regression suite에 추가하기도 쉽다. 도구가 자동 축소를 지원해도 request body만 보지 말고 header, authentication role, 사전 생성된 resource, concurrency, server version을 함께 기록해야 한다.

corpus에는 두 종류의 입력을 섞지 않는 편이 좋다. 첫째는 항상 실행하는 regression corpus다. 이미 수정한 결함과 명확한 보안 경계가 여기에 들어가며 결과가 결정적이어야 한다. 둘째는 탐색용 corpus다. 매 실행마다 새 mutation과 seed를 섞어 아직 모르는 결함을 찾는다. 탐색용 실패가 재현되면 그때 regression으로 승격한다. 이렇게 나누면 매일의 CI는 빠르고 신뢰할 수 있게 유지하면서도, 장기 실행에서는 새로운 입력 공간을 계속 탐색할 수 있다.

## API gateway, WAF와 application 검증의 역할

API gateway나 WAF(Web Application Firewall)는 요청 크기, rate limit, 허용된 content type, 알려진 공격 패턴을 앞단에서 제한할 수 있다. 이것은 퍼즈 테스트 대상이 사라졌다는 뜻이 아니다. gateway가 차단해야 하는 요청과 application이 의미 있게 4xx로 처리해야 하는 요청을 구분해야 한다. 예를 들어 100MB body는 gateway가 일찍 거절하는 편이 좋을 수 있지만, 허용 크기 안의 `quantity=-1`은 application의 business validation이 명확한 오류로 처리해야 한다.

앞단 규칙만 신뢰하면 내부 network, batch, service-to-service 호출이 우회 경로가 될 수 있다. 반대로 application만 모든 대형 입력을 처리하게 두면 자원 소모가 커진다. 퍼즈 시나리오에는 gateway를 통과하는 요청과, 가능하다면 service handler에 직접 들어오는 요청을 나눠 넣어 어느 계층의 방어가 깨졌는지 보이게 한다. 차단된 요청의 status code와 audit log도 검증 대상이다. 무조건 403을 반환했다고 안전한 것이 아니라, 정상 client가 잘못 차단되지 않고 필요한 관찰 정보가 남아야 한다.

WAF rule을 추가한 뒤에는 정상 request와 경계 request를 같이 재실행한다. 특정 문자열이 들어 있다는 이유만으로 검색 API의 합법적인 사용자 입력을 막으면 false positive가 된다. 퍼즈 테스트의 가치는 차단 규칙을 많이 추가하는 것이 아니라, 정책이 기대한 계층에서 일관되게 동작하는지 확인하는 데 있다. 보안 rule 변경도 API behavior의 일부로 보고 version과 배포 시점을 기록하면 원인 분석이 쉬워진다.

## 응답 oracle을 구체적으로 정의하기

퍼즈 테스트에서 가장 흔한 실수는 5xx가 없으면 성공이라고 판단하는 것이다. 예를 들어 권한 없는 사용자가 다른 고객의 주문을 조회했는데 서버가 200과 빈 object를 반환하면 500은 없지만 authorization 계약이 불명확하다. 반대로 입력이 유효하지 않은데 200과 기본값을 반환하면 client가 오류를 알아채지 못할 수 있다. endpoint마다 성공·유효성 오류·인증 오류·권한 오류·충돌 오류의 상태 코드와 최소 body를 정의해 둔다.

또한 오류 응답은 정보 노출 관점의 oracle이 필요하다. 예외 class, SQL 문장, 내부 host 이름, access token, 개인정보가 body나 header에 섞이지 않아야 한다. response header의 CORS 정책, cache control, content type도 입력에 따라 의도치 않게 바뀌지 않는지 확인할 수 있다. 시간 oracle도 중요하다. 비정상적으로 긴 regex 입력이나 깊은 JSON이 timeout을 만들면 status code 이전에 서비스 가용성 문제가 된다. 다만 고정된 매우 짧은 시간 제한은 느린 CI에서 false positive를 만들 수 있으므로 환경별 기준을 구분한다.

상태 변경 API에는 부작용 oracle을 추가한다. 잘못된 요청이 들어온 뒤 row가 생기지 않았는지, queue message가 발행되지 않았는지, 외부 메일이 보내지지 않았는지, 같은 idempotency key에서 결과가 일관적인지 확인한다. 모든 내부 table을 assertion으로 묶을 필요는 없지만, 돈·권한·재고처럼 위험한 결과에 대해서는 관찰 가능한 불변식을 정해야 한다. 이 기준은 QA 혼자 정하기보다 해당 기능의 개발자와 업무 담당자가 함께 합의해야 한다.

## 동시성과 순서 오류를 다루는 범위

하나의 request만 변형하는 fuzz로는 경쟁 조건을 거의 찾지 못한다. 같은 쿠폰을 동시에 적용하거나, 취소와 환불 요청을 역순으로 보내거나, connection이 끊긴 뒤 동일한 idempotency key로 재시도하는 상황에는 시간과 순서가 들어간다. 먼저 정상 흐름을 상태 기계처럼 간단히 적는다. 예를 들어 주문은 `created → paid → shipped → delivered`로 갈 수 있고 취소는 특정 상태에서만 허용된다고 정리한다. 그 뒤 허용되지 않는 전이와 동일 요청 반복을 priority scenario로 만든다.

동시 테스트는 테스트 환경을 쉽게 불안정하게 만들므로, 처음부터 높은 concurrency를 주기보다 두 개 또는 세 개의 요청으로 재현 가능한 작은 race부터 시작한다. 각 요청에 correlation ID를 넣고 시작 장벽을 둬 가능한 한 같은 시점에 실행되게 하며, 결과와 최종 상태를 함께 저장한다. 결함을 발견했다면 thread 수를 늘리기보다 최소한의 병렬 요청과 순서로 줄여 regression test로 옮긴다. 무작위 scheduling에만 의존하면 다음 실행에서 재현되지 않는 flaky test가 되기 쉽다.

이 영역에서 퍼즈 테스트는 load test를 대체하지 않는다. load test는 목표 트래픽에서 지연·용량·오류율을 평가하고, concurrency fuzz는 소수 요청의 순서 경계에서 정합성 오류를 찾는다. 두 테스트의 데이터, 목적, 중지 기준을 분리하면 "서버가 느렸으므로 경쟁 조건" 같은 잘못된 결론을 줄일 수 있다.

## 실행 결과를 제품 개선으로 연결하기

퍼즈 실행이 끝나면 발견 건수만 세지 말고 입력 범주와 root cause를 분류한다. 길이 제한 누락, parser 예외, authorization 순서, 오류 매핑, idempotency, documentation drift, rate limit처럼 묶어 보면 같은 원인이 여러 endpoint에 있는지 보인다. 공유 middleware의 문제라면 endpoint마다 예외를 추가하기보다 공통 validation 또는 error handler를 고치는 것이 더 작고 안전한 해결일 수 있다. 반대로 기능 고유 규칙이라면 그 기능의 계약과 테스트 fixture를 보완한다.

수정 후에는 발견한 최소 request, 가까운 정상 request, 같은 입력을 다른 역할로 보낸 request를 같이 확인한다. 하나의 예외를 잡다가 정상 처리까지 막지 않았는지 보기 위해서다. 결과는 commit, API version, 테스트 환경, seed, 재현 절차와 연결한다. QA 보고서에는 "퍼즈 테스트 완료"보다 어떤 위험을 탐색했고 무엇을 발견했으며 어떤 범위는 아직 포함하지 않았는지를 쓰는 편이 다음 변경에 더 도움이 된다.

## 파일, 인코딩, content negotiation 경계

JSON body만 API 입력이라고 생각하면 중요한 parser 경계를 놓치기 쉽다. 파일 업로드 endpoint는 filename, 확장자, declared content type, 실제 file signature, multipart boundary, file size, 압축 해제 뒤 크기처럼 여러 입력을 동시에 받는다. 이미지 업로드가 허용된다고 해서 선언된 `image/png` header만 믿으면 안 되며, 파일을 저장하거나 변환하는 downstream component가 어떤 형식을 실제로 처리하는지도 확인해야 한다. 퍼즈 테스트는 운영 파일을 쓰지 않는 격리 저장소에서 이 조합을 변형해, 거절과 cleanup이 예상대로 되는지 확인할 수 있다.

문자열 입력에는 UTF-8만이 아니라 normalization과 유사 문자도 문제가 된다. 사람에게는 같은 이메일이나 쿠폰 코드처럼 보이는 두 문자열이 database index에는 다른 값일 수 있고, 반대로 서로 다른 표현이 normalization 뒤 같아질 수 있다. URL encoding을 한 번 또는 두 번 적용했을 때 path traversal처럼 해석이 달라지는지, header와 body의 charset 선언이 다를 때 오류가 안전한지 확인한다. 이 테스트의 목적은 모든 Unicode를 금지하는 것이 아니라, 제품이 지원한다고 말하는 입력을 일관되게 처리하고 지원하지 않는 입력은 예측 가능하게 거절하는지 확인하는 것이다.

`Accept` header와 content negotiation도 간과하기 쉽다. client가 JSON이 아닌 형식을 요청하거나, 비정상적인 charset을 보냈을 때 API가 HTML error page나 framework 기본 stack trace를 돌려주면 정보 노출과 client parsing 오류가 생길 수 있다. 대표 endpoint에 대해 성공과 오류 모두에서 content type·encoding·cache header가 기대와 맞는지 oracle을 두면, 공통 error handler 변경의 부작용을 발견할 수 있다.

## 테스트 환경을 신뢰할 수 있게 만드는 준비

퍼즈 테스트가 불안정하면 실제 결함과 환경 noise를 구분할 수 없다. 실행 전에는 test database가 알려진 fixture 상태인지, 외부 provider가 sandbox 또는 stub인지, rate limit과 시간 제한이 문서화되어 있는지 확인한다. 실행마다 고유한 tenant 또는 접두어를 사용하면 다른 병렬 job과 데이터를 섞지 않을 수 있다. cleanup이 실패하면 다음 실행에서 이미 존재하는 resource 때문에 잘못된 결과가 나오므로, 시작 단계에서 남은 테스트 resource를 검출하고 종료 단계에서 삭제 결과를 기록한다.

관찰성도 준비의 일부다. request마다 correlation ID를 넣고 gateway log, application log, trace를 같은 ID로 찾을 수 있게 하면 수천 요청 중 하나의 실패를 좁히기 쉽다. 단, raw request body를 모두 로그에 남기면 개인정보와 token이 쌓일 수 있으므로 mask 규칙과 sampling을 정한다. 테스트 도구의 stdout만 저장하기보다 endpoint·입력 범주·seed·역할·응답 코드·trace ID 같은 최소 metadata를 남기는 편이 안전하고 재현성도 좋다.

## 도입 순서: 작은 읽기 API부터 시작하기

처음부터 주문·결제처럼 부작용이 큰 API를 목표로 잡으면 환경과 cleanup을 만들다 도입이 멈출 수 있다. 먼저 검색 조건이나 profile 조회처럼 읽기 전용이며 schema가 명확한 endpoint 하나를 고른다. 정상 example을 seed로 두고, 길이·타입·null·인코딩·반복 parameter 정도의 mutation부터 실행한다. 예상하지 못한 5xx와 정보 노출을 수정하고, 최소 재현 case를 regression suite에 넣는다.

다음 단계에서 authentication role과 상태 기반 호출을 추가한다. 그 뒤에만 격리된 test payment provider나 fake queue를 이용해 쓰기 endpoint로 넓힌다. 이 순서는 퍼즈 테스트의 가치를 낮추는 타협이 아니라, 안전한 실행 경계·oracle·triage 습관을 먼저 만드는 방식이다. 각 단계에서 "무엇을 아직 테스트하지 않는가"를 명시하면 팀이 통과 결과를 과신하지 않게 된다.

## 팀의 API 변경 흐름에 붙이기

퍼즈 테스트를 별도 보안 행사로 두면 새로운 endpoint와 schema 변경을 따라가지 못한다. API를 추가하거나 request field를 바꿀 때 OpenAPI 예시, 정상 fixture, 입력 제약, 실패 oracle을 같은 pull request에서 함께 갱신하는 흐름을 만든다. reviewer는 구현이 통과하는지만 보지 말고 새 field의 최대 길이·null 허용·권한 조건·오류 코드가 명시되었는지 확인한다. 이 작은 질문들이 퍼즈 도구가 탐색할 의미 있는 seed를 계속 공급한다.

발견된 결함도 severity만으로 닫지 않는다. 어떤 입력 범주에서 나왔는지, 어느 계층에서 막혔어야 하는지, 고객 영향과 재현성은 어떤지, regression case가 추가됐는지를 기록한다. 같은 endpoint에서 반복되는 validation 오류라면 shared schema validation을 검토하고, 여러 서비스에서 비슷한 오류 body가 다르다면 API guideline과 공통 error handler를 정리할 수 있다. 퍼즈 결과를 개발·QA·보안이 함께 읽는 변경 근거로 쓰면 테스트 실행 횟수보다 실제 예방 효과가 커진다.

## 배포 뒤에도 확인할 신호

퍼즈 테스트는 배포 전 입력 공간을 탐색하지만, 실제 사용자의 다양한 client와 network를 전부 대신하지는 못한다. 배포 뒤에는 4xx·5xx 비율, validation 오류의 field별 분포, request body 크기, timeout, authorization 거절, gateway 차단 수를 관찰한다. 특정 client version에서만 갑자기 400이 늘었다면 새 validation이 정상 사용자를 막고 있을 수 있고, 예상하지 못한 500이 늘었다면 fuzz corpus에 없던 조합이 production에서 나타난 것일 수 있다. 단, 오류 로그의 원문을 수집할 때는 개인정보와 token을 mask하는 원칙을 지킨다.

관찰 결과가 새 결함으로 판단되면 raw customer request를 그대로 공유하기보다 필요한 구조와 경계를 보존한 안전한 fixture를 만든다. 그렇게 만든 사례를 regression corpus와 API 문서에 반영하면 다음 배포 전에 같은 입력을 확인할 수 있다. 이 순환이 있어야 퍼즈 테스트는 일회성 실행이 아니라, 실제 실패에서 배운 입력 경계를 제품 품질 기준으로 축적하는 과정이 된다.

모니터링 수치가 안정적이어도 테스트 범위가 완전하다는 뜻은 아니다. 새 client, 새로운 파일 형식, 권한 정책 변경처럼 입력 모델을 바꾸는 변경이 생기면 seed와 oracle을 다시 검토한다. 안전한 API는 한 번의 통과로 만들어지는 결과가 아니라, 변경과 관찰을 통해 경계를 계속 명확하게 만드는 과정이다.

따라서 실행 결과와 남은 범위를 짧게 남기는 습관이 중요하다. 다음 담당자는 무엇을 신뢰할 수 있고 무엇을 아직 탐색하지 않았는지 알아야 같은 위험을 다시 추측하지 않는다.

## 한계와 적용 기준 Q&A

### Q. 퍼즈 테스트가 통과하면 보안 테스트를 하지 않아도 되나요?

A. 아닙니다. 퍼즈 테스트는 입력 처리와 예외 경계를 탐색하는 좋은 방법이지만, 인증 설계, 권한 모델, dependency 취약점, 비즈니스 로직 악용, 인프라 설정을 모두 증명하지 않습니다. 위협 모델링, 코드 리뷰, 보안 점검, 접근 제어 테스트와 함께 사용해야 합니다.

### Q. 400 응답이 많이 나오면 API 품질이 나쁜가요?

A. 아닙니다. 잘못된 입력을 명확한 4xx로 안전하게 거절하는 것은 오히려 기대 행동일 수 있습니다. 중요한 것은 예상 밖 5xx, 긴 timeout, 민감 정보 노출, 잘못된 상태 변경, 명세와 다른 오류 의미가 있는지입니다.

### Q. OpenAPI가 있으면 퍼즈 도구를 바로 붙여도 되나요?

A. 명세를 seed로 활용할 수 있지만, 먼저 실제 endpoint·인증·예시·제약 조건이 최신인지 확인하세요. 오래된 명세는 유효하지 않은 요청만 만들거나 실제 breaking change를 놓칠 수 있습니다. 대표 요청을 통해 명세와 구현의 일치를 확인한 뒤 범위를 넓히는 편이 안전합니다.

### Q. 언제 도입을 피하거나 미루는 편이 좋나요?

A. 테스트 환경이 production과 분리되지 않았거나, 외부 결제·메일 같은 부작용을 차단할 수 없고, 발견된 실패를 분석할 로그와 담당자가 없다면 먼저 그 기반을 마련하는 편이 낫습니다. 퍼즈 테스트는 많은 실패 신호를 만들 수 있으므로 안전한 실행 경계와 triage 과정이 준비된 뒤 가치가 커집니다.

## 마무리

API 퍼즈 테스트는 무작위 입력을 경쟁적으로 많이 보내는 활동이 아니라, 사람이 놓치기 쉬운 입력·상태·권한 경계에서 시스템이 안전하게 실패하는지 확인하는 방법이다. 정상 fixture에서 출발해 구조를 유지한 변형을 만들고, 불변식과 안전 장치를 먼저 정하며, 발견한 실패는 최소 재현 fixture로 회귀 테스트에 옮기는 흐름이 핵심이다. 단위·명세·통합 테스트와 역할을 나누면 퍼즈 테스트는 불확실성을 늘리는 도구가 아니라 API 경계를 더 단단하게 만드는 탐색 도구가 된다.

<h3 class="references-heading">참고 자료</h3>

- [OWASP Web Security Testing Guide: Fuzzing](https://owasp.org/www-project-web-security-testing-guide/)
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [GitLab API Fuzzing documentation](https://docs.gitlab.com/user/application_security/api_fuzzing/)
