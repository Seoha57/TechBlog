---
layout: post
title: "Kubernetes Gateway API를 이해하는 법: Gateway·Route·정책 분리와 트래픽 운영 기준"
date: 2026-10-26 08:30:00 +0900
category: Infrastructure
description: "Kubernetes Gateway API의 GatewayClass·Gateway·HTTPRoute·정책 모델을 Ingress와 비교하며, 팀 권한 분리와 안전한 트래픽 전환 기준을 설명합니다."
---

<section class="quick-answers"><h2>먼저 답하기</h2><p><strong>Q. Gateway API는 Ingress를 이름만 바꾼 기능인가요?</strong><br>A. 아닙니다. Gateway API는 클러스터 인프라를 관리하는 사람과 애플리케이션 경로를 관리하는 사람의 책임을 분리하고, HTTP뿐 아니라 TCP·TLS 같은 연결 규칙을 더 명확히 표현하려는 Kubernetes API 묶음입니다.</p><p><strong>Q. Ingress가 동작하는데 당장 전부 바꿔야 하나요?</strong><br>A. 아닙니다. 기존 Ingress가 요구사항을 충족하면 유지할 수 있습니다. 여러 팀의 경로 위임, 점진적 트래픽 전환, 공급자별 annotation 의존성 감소가 필요한 지점부터 Gateway API를 검토하는 편이 안전합니다.</p></section>

Kubernetes에서 외부 사용자가 서비스에 들어오는 길은 생각보다 많은 요소를 거칩니다. DNS가 이름을 IP 주소로 바꾸고, 로드 밸런서가 연결을 받고, TLS가 암호화를 협상한 뒤, HTTP 경로와 호스트 이름에 따라 어느 Service로 보낼지를 결정합니다. 작은 클러스터에서는 이 구성을 한 팀이 관리할 수 있지만, 서비스와 팀이 늘면 “누가 공용 진입점을 만들고”, “누가 `/orders` 경로를 등록하며”, “인증서와 방화벽 정책은 누가 바꾸는가”가 중요한 운영 문제가 됩니다.

Kubernetes Ingress는 오랫동안 HTTP 진입 규칙을 표현하는 표준 API였습니다. 그러나 구현별 annotation이 늘면서 같은 YAML이라도 controller마다 의미가 달라지기 쉬웠고, 공용 로드 밸런서의 소유자와 개별 애플리케이션의 경로 소유자를 나누는 표현도 제한적이었습니다. Gateway API는 이 문제를 해결하기 위해 역할별 리소스와 명시적인 연결 규칙을 제시합니다. 새 리소스가 많아 보이지만, 핵심은 트래픽 기능을 복잡하게 만드는 것이 아니라 권한과 변경 범위를 읽기 쉽게 만드는 데 있습니다.

## 먼저 알아둘 기반 기술

L4와 L7은 네트워크 장비나 프록시가 어떤 수준의 정보를 보고 판단하는지를 설명하는 말입니다. L4 전송 계층은 TCP나 UDP의 포트와 연결을 주로 다룹니다. L7 응용 계층은 HTTP의 host, path, header처럼 요청 내용을 읽고 다른 서비스로 보낼 수 있습니다. `api.example.com/orders`와 `api.example.com/payments`를 다른 서비스로 보내는 규칙은 일반적으로 L7 라우팅입니다.

로드 밸런서(load balancer)는 들어온 연결을 여러 서버로 나누는 장치 또는 서비스입니다. 리버스 프록시(reverse proxy)는 사용자를 대신해 뒤쪽 서비스에 요청을 전달합니다. TLS(Transport Layer Security)는 브라우저와 서버 사이 데이터를 암호화하는 프로토콜이며, 인증서는 사용자가 접속한 도메인이 올바른 서버라는 것을 검증하는 근거가 됩니다. Kubernetes Service는 Pod IP가 바뀌어도 애플리케이션을 안정된 이름으로 찾게 해 주는 내부 접근 지점입니다.

Kubernetes의 선언형 구성은 “어떤 명령을 실행하라”보다 “원하는 최종 상태는 이것이다”를 YAML로 적는 방식입니다. controller는 이 선언을 보고 실제 로드 밸런서·프록시 설정을 맞추려고 동작합니다. 따라서 Gateway API YAML을 적용했다고 곧바로 네트워크가 바뀌는 것은 아닙니다. 클러스터에 해당 API를 구현하는 controller가 있어야 하며, 그 controller가 지원하는 기능과 상태 조건을 함께 확인해야 합니다.

## Gateway API의 네 가지 역할

GatewayClass는 어떤 구현체가 Gateway를 처리할지를 가리키는 클러스터 범위 리소스입니다. 예를 들어 조직이 선택한 Gateway controller가 `example.net/gateway-controller`라는 controller name을 등록할 수 있습니다. 인프라 운영자는 어떤 클래스가 허용되는지, 어떤 클라우드 로드 밸런서·네트워크 정책과 연결되는지 관리합니다. 애플리케이션 팀이 임의로 외부 IP를 만드는 일을 막는 첫 경계가 될 수 있습니다.

Gateway는 실제 진입점의 의도를 표현합니다. 어떤 GatewayClass를 사용하고, 어느 포트에서 HTTP 또는 HTTPS를 받고, 어떤 hostname과 TLS 인증서를 쓸지 같은 listener를 정의합니다. 공용 `https://api.example.com`의 443 포트를 인프라 팀이 하나의 Gateway로 관리한다면, 여러 애플리케이션은 그 Gateway에 경로만 붙일 수 있습니다. listener는 모든 Route를 아무 namespace에서나 받지 않도록 허용 범위도 정할 수 있습니다.

Route는 들어온 요청을 BackendRef, 즉 Service와 포트로 보내는 규칙입니다. HTTPRoute는 hostname, path, method, header, query parameter 같은 HTTP 조건을 사용합니다. Route를 가진 팀은 자신 서비스의 경로를 바꾸되 공용 로드 밸런서 자체나 다른 팀의 인증서에 접근하지 않아도 됩니다. 이 분리는 단순 편의가 아니라 실수로 공용 진입점을 삭제하거나 과도한 권한을 갖는 위험을 줄이는 방식입니다.

정책 리소스는 timeout, retry, 인증, 속도 제한, 보안 정책처럼 Route만으로 표현하기 어려운 운영 규칙을 연결하는 방식으로 사용됩니다. 다만 “Policy”라는 이름의 모든 기능이 Gateway API 표준 코어에 포함되는 것은 아닙니다. 구현체 또는 확장 API마다 지원 범위가 다를 수 있으므로, YAML 예시를 복사하기 전에 해당 controller의 문서와 상태 조건을 확인해야 합니다. Gateway API의 이식성은 표준 필드부터 시작하며, 공급자별 확장을 썼다면 그 의존성을 명시해야 합니다.

## Ingress와 무엇이 다른가

Ingress는 `host`와 `path`를 Service로 연결하는 단순한 경우에 여전히 이해하기 쉽습니다. 그러나 TLS 설정, redirect, header 조작, 가중치 기반 분할, namespace 간 위임이 필요해질수록 controller annotation이 YAML 곳곳에 퍼질 수 있습니다. annotation은 빠른 확장 수단이지만, 어느 controller의 어떤 버전에서 동작하는지 코드 리뷰만으로 알아보기 어렵다는 단점이 있습니다.

Gateway API는 listener와 Route를 분리해 “접속 지점”과 “애플리케이션 경로”의 소유자가 다를 수 있음을 모델에 넣었습니다. 또한 Route의 parentRef로 어느 Gateway의 어느 listener에 붙는지 명시할 수 있고, Gateway는 allowedRoutes로 어떤 namespace의 Route를 받을지 제한할 수 있습니다. 같은 클러스터에 여러 제품이 있을 때, 이 구조는 새 서비스 온보딩과 권한 검토를 더 예측 가능하게 합니다.

그렇다고 Gateway API가 자동으로 더 안전하거나 더 빠른 것은 아닙니다. 실제 데이터 평면은 controller가 만드는 프록시와 클라우드 로드 밸런서에 달려 있습니다. 또한 Ingress에서 쓰던 rewrite, session affinity, WAF 연동 기능이 같은 방식으로 옮겨지는지 확인해야 합니다. 마이그레이션은 리소스 이름을 바꾸는 작업이 아니라 현재 트래픽 규칙과 controller 의존성을 목록화하는 작업에서 시작해야 합니다.

## 가장 작은 HTTPRoute 예시

아래 예시는 `store` namespace의 `catalog` Service로 `/catalog` 경로를 보내려는 의도입니다. 실제 적용 전에는 Gateway 이름, Service 포트, controller 지원 버전이 환경과 맞는지 확인해야 합니다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: catalog
  namespace: store
spec:
  parentRefs:
    - name: public-https
      namespace: platform
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /catalog
      backendRefs:
        - name: catalog
          port: 8080
```

여기서 중요한 검증 대상은 YAML이 적용됐다는 사실만이 아닙니다. Route의 status에 parent Gateway가 수락했는지, 참조한 Service와 port가 존재하는지, DNS와 인증서가 새 hostname을 가리키는지, 기대하지 않은 경로가 기본 backend로 흘러가지 않는지를 확인해야 합니다. `kubectl get httproute -o yaml`에서 Accepted·ResolvedRefs 같은 condition을 읽는 습관은 controller 로그만 보고 추측하는 시간을 줄여 줍니다.

## 권한 분리와 namespace 경계

예를 들어 플랫폼 팀은 `platform` namespace의 Gateway와 TLS secret을 관리하고, 결제·주문·카탈로그 팀은 각자 namespace의 HTTPRoute만 수정한다고 해 보겠습니다. RBAC(Role-Based Access Control) 권한을 이 역할에 맞춰 나누면 앱 팀은 자신의 Route를 배포할 수 있지만 공용 listener의 포트나 인증서를 바꾸지는 못합니다. 사고가 났을 때 변경 가능한 범위가 작아지고, 리뷰 대상도 명확해집니다.

그러나 namespace가 다르다는 사실만으로 격리가 완성되지는 않습니다. Gateway가 모든 namespace의 Route를 허용하면 예상하지 않은 팀이 공용 도메인에 경로를 붙일 수 있습니다. allowedRoutes의 namespace 정책, hostname 사용 규칙, Service 참조 허용 범위를 함께 정해야 합니다. 특히 다른 namespace의 backend를 참조하는 기능은 편리하지만, 명시적인 승인 리소스와 조직 규칙 없이 열어 두면 경계가 흐려질 수 있습니다.

도메인 소유도 사전에 정해야 합니다. `api.example.com/payments`는 결제 팀이 소유하지만 `api.example.com/*`의 catch-all 규칙은 플랫폼 팀이 소유한다는 식으로 원칙을 문서화합니다. 서로 겹치는 path와 hostname이 생기면 어떤 Route가 이길지 controller 구현과 우선순위 규칙을 확인해야 합니다. 애매한 규칙은 배포 순서에 따라 다른 결과를 만들 수 있으므로, 경로 등록을 자동 검사하거나 리뷰 체크리스트에 중복 검토를 넣는 편이 낫습니다.

## 트래픽 전환을 안전하게 설계하기

새 버전을 한 번에 모든 사용자에게 보내는 대신, backendRefs에 가중치를 두어 일부 트래픽만 새 Service로 보내는 패턴을 사용할 수 있습니다. 예를 들어 기존 `catalog-v1`과 새 `catalog-v2`를 함께 두고, 기능과 관찰 지표가 안정적인지 확인하며 비율을 올립니다. 이 방식은 배포 위험을 줄이지만, 사용자 한 명의 연속 요청이 다른 버전으로 갈 수 있다는 점도 고려해야 합니다. 세션 상태나 캐시 키가 버전 간에 호환되는지 확인하지 않으면 작은 비율에서도 오류가 날 수 있습니다.

전환 전에는 정상 응답률만 보지 말고, HTTP 상태 코드 분포, 지연 시간, upstream 연결 오류, 인증 실패, 주문 같은 업무 결과를 함께 봅니다. 새 버전이 200을 반환해도 응답 형식이 달라 클라이언트가 실패할 수 있고, 일부 경로만 rewrite 규칙을 잃어 404가 날 수도 있습니다. 지표를 볼 기간과 되돌릴 임계값을 배포 전에 정하면, 담당자가 불안한 수치를 보고 즉흥적으로 트래픽을 바꾸는 일을 줄일 수 있습니다.

rollback은 YAML을 이전 버전으로 되돌리는 것만 의미하지 않습니다. DNS TTL, 인증서 교체, 데이터베이스 migration, 메시지 형식이 함께 바뀌었다면 이전 backend가 여전히 요청을 처리할 수 있는지도 확인해야 합니다. Gateway API는 트래픽 규칙을 읽기 좋게 만들지만 애플리케이션 호환성까지 보장하지는 않습니다. 따라서 작은 가중치 전환과 명확한 상태 확인은 기능 배포 전략과 함께 설계해야 합니다.

## TLS와 인증서 운영 기준

HTTPS listener를 만들 때 인증서 secret을 어느 namespace에 두고 누가 갱신하는지 정해야 합니다. 인증서 자동 발급 도구를 쓰더라도 도메인 검증 실패, 갱신 권한, 만료 알림, 비상시 수동 교체 절차는 남습니다. 인증서가 만료되면 Route가 정확해도 사용자는 연결하지 못하므로, Gateway 상태와 별도로 만료 시점과 갱신 성공을 관찰해야 합니다.

TLS를 Gateway에서 종료하면 Gateway와 backend Service 사이 구간을 어떻게 보호할지도 선택해야 합니다. 같은 클러스터 내부라고 무조건 신뢰할 수 있는 것은 아닙니다. 민감한 서비스라면 NetworkPolicy, workload identity, backend TLS 중 무엇이 필요한지 위협 모델부터 정합니다. 반대로 모든 구간에 복잡한 암호화 설정을 얹어 장애 원인을 찾기 어렵게 만드는 것도 비용이므로, 데이터 민감도와 네트워크 신뢰 경계를 기준으로 결정합니다.

인증과 인가는 Route의 path 매칭과 다른 문제입니다. JWT 검증, 사용자 권한, API key 검증을 어느 계층에서 수행할지 정하고, 그 정책이 우회 경로 없이 모든 backend에 적용되는지 테스트해야 합니다. Gateway controller의 특정 확장을 쓰는 경우에는 controller 교체 또는 업그레이드 때 정책이 유지되는지도 확인합니다. 보안 정책은 “적용했다”는 선언보다 실제 차단·허용 시나리오로 검증하는 편이 안전합니다.

## 관찰과 장애 진단

Gateway 문제를 진단할 때는 요청이 어디까지 왔는지를 계층별로 나눕니다. 먼저 DNS가 올바른 주소를 주는지, 로드 밸런서 listener가 연결을 받는지, TLS handshake가 성공하는지, Gateway가 Route를 Accepted 상태로 봤는지, backend Service endpoint가 준비됐는지, 애플리케이션이 정상 응답하는지를 순서대로 확인합니다. 이 순서가 있으면 “외부 접속이 안 된다”는 넓은 증상을 작은 후보로 나눌 수 있습니다.

로그와 trace에는 request ID 또는 correlation ID를 전달하면 좋습니다. Gateway access log의 host·path·status·upstream latency와 애플리케이션 로그의 같은 ID를 연결하면, 라우팅 오류인지 backend 지연인지 판단하기 쉬워집니다. 다만 query string이나 authorization header처럼 민감한 값을 무조건 로그에 남기면 안 됩니다. 관찰 가능성은 더 많은 로그를 쌓는 일이 아니라, 필요한 사건을 안전하게 연결하는 일입니다.

장애 대응 중 Route를 급히 수정할 때는 적용 전후의 리소스 상태를 저장하고, 한 번에 여러 규칙을 바꾸지 않는 편이 좋습니다. host·path·backend·TLS를 동시에 바꾸면 어느 변경이 문제를 만들었는지 알기 어렵습니다. 작은 변경 단위, 상태 condition 확인, 실제 외부 요청 검증, 되돌릴 manifest 준비가 운영에서 가장 단순한 안전장치입니다.

## HTTP 규칙을 검증 가능한 계약으로 만들기

Route 규칙을 작성할 때 가장 흔한 실수는 정상 경로 하나만 확인하는 것입니다. `/catalog`가 200을 돌려준다고 해서 `/catalogue`가 같은 backend로 잘못 가지 않는지, 대소문자나 trailing slash가 기대대로 처리되는지, 다른 hostname 요청이 차단되는지는 알 수 없습니다. path prefix, exact path, header match, method match가 섞이면 사람이 읽는 의도와 controller의 실제 선택 규칙이 달라질 수 있습니다. 각 Route에는 허용할 요청과 거절할 요청을 함께 적고 자동 테스트로 남기는 편이 좋습니다.

계약 테스트는 curl 한 번으로 끝나지 않습니다. public Gateway를 통과하는 요청, 클러스터 내부 Service 직접 요청, 인증 없이 보낸 요청, 잘못된 host header, 존재하지 않는 path, backend가 준비되지 않은 상황을 구분합니다. 기대 결과도 모두 404가 아닐 수 있습니다. 인증이 필요한 경로는 401 또는 403이어야 하고, 존재하지 않는 경로는 의도한 기본 backend 또는 404로 끝나야 하며, 준비되지 않은 backend는 사용자가 재시도할 수 있는 오류 형식으로 보여야 합니다. 이 결과를 정하지 않으면 배포마다 controller의 기본 동작에 기대게 됩니다.

HTTPRoute filter를 이용해 redirect나 URL rewrite를 적용할 때는 특히 보수적으로 검증합니다. `/v1`을 `/`로 바꾸는 규칙 하나가 정적 파일 경로나 callback URL까지 바꿀 수 있고, redirect 응답은 클라이언트와 검색 엔진의 캐시에 오래 남을 수 있습니다. 먼저 작은 경로에서 적용하고, 원래 URL과 바뀐 URL, query string 보존, 인증 header 전달, 오류 페이지를 모두 확인하세요. 규칙을 읽는 사람에게도 변환 전후가 명확해야 하므로 여러 filter를 겹치기보다 필요한 최소 규칙을 유지하는 편이 낫습니다.

## 시간 제한과 재시도의 책임

Gateway에서 timeout을 정한다고 해서 backend의 모든 느린 요청이 해결되지는 않습니다. client timeout, CDN 또는 load balancer timeout, Gateway timeout, 애플리케이션 timeout, 데이터베이스와 외부 API timeout이 서로 다를 수 있습니다. 바깥 계층이 안쪽보다 먼저 포기하도록 무작정 짧게 잡으면 서버는 일을 계속하는데 사용자는 실패를 보고 재시도할 수 있습니다. 반대로 너무 길면 연결과 worker가 묶여 장애가 더 넓게 퍼질 수 있습니다.

따라서 업무별로 최대 허용 시간과 취소 가능성을 정합니다. 단순 조회는 짧은 시간 안에 응답하지 못하면 오류로 끝내는 편이 낫고, 보고서 생성처럼 오래 걸리는 작업은 비동기 job을 만들고 진행 상태를 조회하게 하는 편이 더 적합할 수 있습니다. Gateway의 timeout은 이 제품 정책을 구현하는 한 층이지, 애플리케이션의 처리 모델을 대신 정하는 마법 값이 아닙니다. 설정 변경 뒤에는 timeout 직전과 직후의 요청이 어떤 status·로그·업무 상태를 남기는지 확인합니다.

retry도 같은 원칙을 따릅니다. GET처럼 부수 효과가 없는 조회는 일시적 upstream 오류에 제한된 재시도를 고려할 수 있지만, 주문 생성 같은 명령을 Gateway가 함부로 재시도하면 중복 처리가 일어날 수 있습니다. 명령 endpoint는 애플리케이션의 멱등성 규칙과 함께 설계하고, Gateway의 재시도 대상 status·횟수·대상 method를 명시합니다. 재시도가 사용자 경험을 돕는지, 단지 장애 시 backend 부하를 키우는지 관찰 지표로 확인해야 합니다.

## 클러스터 네트워크와 함께 보기

Gateway API는 외부에서 들어오는 경로를 표현하지만, Gateway에서 backend Pod까지의 네트워크가 항상 허용된다는 뜻은 아닙니다. NetworkPolicy를 사용하면 Gateway controller 또는 data plane Pod가 애플리케이션 namespace로 연결할 수 있는지 별도로 허용해야 합니다. 새 Route를 적용했는데 502 또는 timeout이 난다면 YAML의 backend 이름만 보지 말고 Service endpoint, Pod readiness, namespace label, NetworkPolicy egress·ingress 규칙을 순서대로 확인합니다.

여러 클러스터나 여러 네트워크 구역을 연결하는 경우에는 DNS와 health check도 경계가 됩니다. 외부 load balancer가 health check를 어떤 path·port로 보내는지, 그 요청이 인증 정책에 막히지 않는지, readiness probe와 사용자가 보는 health endpoint가 같은 의미인지 정해야 합니다. health check가 200이라고 해서 업무 API가 정상이라는 보장은 없으며, 반대로 내부 세부 정보를 health endpoint에 노출해도 안 됩니다. 살아 있음과 준비됨, 실제 기능 가능 상태를 구분해 설계합니다.

IPv4와 IPv6, HTTP/1.1과 HTTP/2, WebSocket 같은 연결 특성도 서비스에 따라 확인 대상이 됩니다. Gateway가 지원한다고 적혀 있어도 controller 버전·클라우드 load balancer·backend 프레임워크 조합에서 기대대로 동작하는지 사전 검증이 필요합니다. 모든 프로토콜을 처음부터 지원하려고 복잡하게 만들기보다, 제품이 실제로 쓰는 연결만 명확히 선택하고 새 요구가 생길 때 호환성 테스트를 추가하세요.

## 구성 변경의 리뷰와 복구 절차

Gateway manifest는 애플리케이션 코드만큼 중요한 변경입니다. 특히 공용 Gateway와 listener 변경은 여러 팀의 트래픽에 영향을 줄 수 있으므로, 누가 어떤 hostname·path를 소유하는지, 영향 받는 서비스는 무엇인지, 적용과 rollback 순서는 무엇인지를 pull request에 적는 습관이 좋습니다. YAML diff가 작아도 listener의 allowedRoutes나 TLS 참조가 바뀌면 영향 범위가 클 수 있습니다.

배포 파이프라인에는 문법 검사뿐 아니라 참조 검사를 넣을 수 있습니다. Route가 가리키는 Gateway와 Service가 존재하는지, namespace와 port가 맞는지, 중복된 hostname·path가 없는지, 허용되지 않은 cross-namespace 참조가 없는지 확인합니다. 실제 controller가 만드는 상태는 런타임에만 알 수 있으므로, staging 환경에서 condition과 외부 요청을 확인하는 단계도 필요합니다. 정적 검사는 사고를 모두 막지는 못하지만 명백한 오타를 production까지 보내지 않는 가장 싼 방어입니다.

복구 때는 가장 먼저 사용자 영향과 마지막 정상 구성을 확인합니다. 급한 상황에서 공용 Gateway를 삭제했다가 더 넓은 장애를 만들지 않도록, 새 Route의 가중치를 0으로 내리거나 특정 hostname만 이전 backend로 돌리는 선택지를 준비합니다. 인증서·DNS·backend 이미지까지 동시에 되돌릴 필요가 있는지 분리해 판단하고, 각 조치 뒤 실제 요청과 상태 condition을 확인합니다. 좋은 runbook은 모든 답을 담은 문서가 아니라, 압박 속에서도 안전한 다음 확인을 알려 주는 짧은 순서입니다.

## 멀티테넌트 환경의 도메인과 비용 경계

여러 고객 조직이 같은 클러스터를 공유하는 멀티테넌트 환경에서는 Route가 곧 외부 노출 계약이 됩니다. 고객별 subdomain을 쓸지, 공용 도메인 아래 path를 나눌지, wildcard 인증서를 누가 관리할지, 고객이 자기 hostname을 연결할 수 있는지를 먼저 결정해야 합니다. path 기반 분리는 시작하기 쉽지만 cookie 범위와 URL 충돌을 주의해야 하고, subdomain 분리는 경계가 선명하지만 DNS·인증서 운영이 늘어납니다. Gateway API는 이 선택을 대신하지 않지만 listener와 hostname 규칙을 선언으로 보이게 합니다.

테넌트별로 rate limit, 인증 정책, 관찰 데이터 접근 권한, 비용을 분리해야 할 수도 있습니다. 특정 고객의 과도한 요청이 공용 Gateway의 연결과 backend 용량을 소진하면 다른 고객도 영향을 받습니다. controller 확장이나 별도 edge 계층으로 제한을 구현할 때는 정책이 어느 listener와 Route에 적용되는지, 우회 가능한 내부 경로가 없는지, 거절 응답이 고객에게 이해 가능한지 확인합니다. rate limit은 보안 기능이면서 용량 보호 장치이지만, 정상적인 배치나 장애 재시도를 막을 수 있으므로 기준과 예외 절차가 필요합니다.

관찰 데이터도 테넌트 경계를 지켜야 합니다. 공용 access log에 hostname·조직 ID를 남길 수는 있지만, 한 고객의 URL·header·오류 정보를 다른 고객 지원 담당자가 볼 수 있으면 안 됩니다. 지표와 trace에서 조직 식별자를 어떤 수준으로 사용하고, 대시보드 권한을 어떻게 나누며, 오래된 로그를 언제 삭제할지 운영 규칙을 둡니다. Gateway API의 namespace 분리와 관찰 시스템의 접근 제어가 같은 경계를 따를 때 사고 대응이 단순해집니다.

## 용량 계획과 부하 테스트

Gateway는 모든 외부 요청이 통과할 수 있는 공용 병목입니다. backend Pod 수만 늘려도 Gateway controller, data plane proxy, cloud load balancer, NAT, 인증서 처리, DNS가 충분하지 않으면 지연이 생길 수 있습니다. 용량 계획에서는 초당 요청 수만 보지 말고 동시 연결, 긴 응답, 요청·응답 크기, TLS handshake 비율, WebSocket 같은 장기 연결, retry가 만드는 추가 요청을 함께 고려합니다. 서비스 특성에 맞는 부하 시나리오가 필요합니다.

부하 테스트는 production 트래픽과 격리된 환경에서 시작하고, 정상 부하뿐 아니라 backend가 느려지거나 일부 Pod가 준비되지 않은 경우도 넣습니다. 이때 확인할 것은 Gateway의 CPU만이 아닙니다. 4xx·5xx 분포, upstream connection 오류, p95 지연, 활성 연결, backend saturation, autoscaling 반응, 로그와 metric의 수집 비용을 함께 봅니다. 부하 도구가 실제 고객과 같은 인증·호스트·경로를 쓰되, 실제 주문이나 데이터 변경을 만들지 않도록 테스트 전용 계정과 endpoint를 사용합니다.

최대 처리량 숫자 하나를 문서에 고정하는 것은 위험합니다. controller 버전, 노드 종류, TLS 설정, 요청 크기, backend 속도에 따라 결과가 크게 달라질 수 있기 때문입니다. 대신 현재 환경에서 측정한 전제와 관찰 지표, 경고 임계값, 확장·축소 절차를 기록합니다. 용량이 부족할 때는 새 인스턴스를 늘리는 것뿐 아니라 느린 backend와 무한 retry를 먼저 찾는 것이 더 효과적일 수 있습니다.

## 한계와 적용 기준 Q&A

### Q. Gateway API를 쓰면 Ingress controller가 필요 없나요?

A. Gateway API도 실제 트래픽을 처리할 controller가 필요합니다. 어떤 제품은 Ingress와 Gateway API를 모두 지원할 수 있고, 지원하는 Route·정책 기능은 버전마다 다를 수 있습니다. API 리소스를 설치한 사실과 실제 controller가 이를 처리하는 사실을 구분해서 확인해야 합니다.

### Q. 모든 마이크로서비스가 자기 Gateway를 가져야 하나요?

A. 보통은 아닙니다. 외부 주소, 인증서, 보안 정책이 같은 서비스는 공용 Gateway와 분리된 Route를 공유하는 편이 관리하기 쉽습니다. 독립된 네트워크 경계·규제·성능 요구가 있는 경우에만 별도 Gateway가 필요한지 검토하세요. Gateway를 많이 만들면 격리는 늘 수 있지만 IP·인증서·운영 비용도 늘어납니다.

### Q. Controller마다 동작이 다르면 표준의 의미가 없지 않나요?

A. 표준 필드는 공통 언어를 주지만, 구현별 확장과 지원 수준은 남습니다. 그래서 처음에는 GatewayClass·Gateway·HTTPRoute 같은 핵심 기능으로 설계하고, 특정 annotation이나 확장을 써야 한다면 의존성과 대체 계획을 문서에 남기는 것이 좋습니다. 이식성은 ‘어느 제품에서도 완전히 같은 기능’보다 ‘차이를 알아차릴 수 있는 구조’에 가깝습니다.

### Q. Gateway API를 도입했는데 Route가 Accepted가 아니면 무엇부터 봐야 하나요?

A. 먼저 Route의 status condition 메시지와 parentRef의 Gateway·listener 이름을 확인합니다. 다음으로 Gateway가 그 namespace의 Route를 허용하는지, hostname이 listener와 맞는지, backend Service와 port를 참조할 수 있는지 점검하세요. 권한 또는 참조 오류를 우회하려고 공용 Gateway를 넓게 열기보다, 거절된 이유를 기준으로 필요한 범위만 수정하는 편이 안전합니다.

## 팀이 합의할 최소 운영 규칙

Gateway API를 안정적으로 쓰려면 모든 서비스가 복잡한 네트워크 지식을 가질 필요는 없습니다. 대신 누가 GatewayClass와 공용 listener를 관리하는지, 새 hostname과 path를 등록할 때 어떤 리뷰를 받는지, 인증서·보안 정책·timeout의 기본값은 무엇인지, 장애 때 어느 대시보드와 runbook을 보는지를 짧게 합의하면 됩니다. 이 규칙이 없으면 선언형 YAML은 늘어나지만 책임은 여전히 사람들의 기억에 남습니다.

앱 팀의 배포 템플릿에는 HTTPRoute의 hostname·path·backend port·health 검증을 명확히 넣고, 플랫폼 팀의 템플릿에는 Gateway·allowedRoutes·TLS·관찰 설정을 둡니다. 서로의 리소스를 복사해 수정하기보다 필요한 입력만 계약으로 주고받으면, 공용 인프라 변경과 서비스 배포를 독립적으로 진행하기 쉬워집니다. 새 기능은 처음부터 모든 팀에 강제하지 말고, 반복되는 경로 등록·권한 검토·장애 대응에서 실제로 비용을 줄이는지 확인하며 확장하세요.

## 도입 체크리스트

도입 후 첫 달에는 Route 수나 YAML 줄 수보다 변경 실패율과 장애 조사 시간을 살펴보세요. 새 서비스가 경로를 등록할 때 필요한 승인과 배포 시간이 줄었는지, 잘못된 참조가 staging에서 발견되는지, 공용 진입점 사고에서 누가 무엇을 확인해야 하는지 명확해졌는지가 더 중요한 신호입니다. 이 결과를 바탕으로 기본 listener, timeout, 보안 정책, 관찰 필드를 조금씩 표준화하면 팀에 맞지 않는 거대한 플랫폼 규칙을 한 번에 강요하지 않을 수 있습니다.

또한 controller 업그레이드는 일반 애플리케이션 배포처럼 별도 검증 대상입니다. Gateway API의 지원 버전과 condition 표현, 확장 정책의 호환성이 달라질 수 있으므로, 핵심 Route·TLS·redirect·가중치 전환을 재현하는 smoke test를 준비합니다. 업그레이드 전에 현재 사용 중인 확장을 목록화하고, 중단되는 기능과 대체 방법을 확인하세요. 선언형 API를 쓴다고 구현체 변화의 영향을 피할 수 있는 것은 아닙니다.

도입 전에 현재 Ingress와 로드 밸런서 규칙을 hostname·path·TLS·redirect·인증·rewrite·timeout·WAF 연동 기준으로 목록화합니다. 각 규칙이 Gateway API의 표준 필드로 옮겨지는지, controller 확장이 필요한지, 아직 지원하지 않는지를 표시하세요. 이 목록이 없으면 마이그레이션 뒤 드물게 쓰던 경로나 오류 응답 규칙을 놓치기 쉽습니다.

첫 대상은 의존성이 적고 되돌리기 쉬운 서비스가 좋습니다. 별도 hostname 또는 제한된 path에 Gateway와 HTTPRoute를 만들고, DNS·TLS·정상 요청·잘못된 경로·인증 실패·backend 장애 응답을 확인합니다. 이후 트래픽 비율과 지표를 관찰하며 범위를 넓힙니다. 기존 Ingress를 제거하는 시점은 새 경로가 동작한다는 것만이 아니라, 모니터링·runbook·권한 규칙까지 새 구조에 맞춰졌는지 확인한 뒤 결정합니다.

Gateway API는 YAML을 더 길게 쓰기 위한 기술이 아닙니다. 공용 진입점, 애플리케이션 경로, 보안 정책의 소유자를 분리하고 트래픽 변경을 검토 가능한 선언으로 남기기 위한 도구입니다. 팀 경계와 운영 절차가 먼저 정리되어 있다면 이 API는 네트워크를 덜 마술처럼 만들고, 변경의 영향 범위를 더 분명하게 보여 줍니다.

결국 성공 기준은 Gateway 리소스 개수가 아니라 서비스 팀이 안전하게 경로를 배포하고, 플랫폼 팀이 공용 진입점의 안정성을 지키며, 장애 때 두 팀이 같은 상태와 근거를 보고 협력할 수 있는지입니다. 이 기준으로 작게 시작해 운영 규칙을 다듬으면 Gateway API는 새 기술 부담보다 명확한 경계라는 이점을 먼저 제공할 수 있습니다.

새 경로를 추가할 때마다 이 경계와 검증 순서를 반복하면, 인프라 변경은 특별한 이벤트가 아니라 관리 가능한 일상 작업이 됩니다.

작은 검증을 꾸준히 남기는 것이 핵심입니다.

이 원칙을 지키세요.

명확한 책임과 증거가 안정적인 운영을 만듭니다.

<h3 class="references-heading">참고 자료</h3>

- [Gateway API Guides](https://gateway-api.sigs.k8s.io/guides/)
- [Kubernetes: Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
