---
layout: post
title: "Kubernetes Gateway API는 Ingress를 어떻게 바꾸는가"
date: 2026-09-16 00:00:00 +0900
categories: [infrastructure]
tags: [infrastructure, kubernetes, gateway-api, ingress, networking]
---

Kubernetes에서 외부 트래픽을 서비스로 연결할 때 오랫동안 Ingress가 많이 사용되었습니다. 하지만 조직과 서비스가 커지면 하나의 Ingress 리소스에 서로 다른 팀의 라우팅 규칙, 컨트롤러별 annotation, 인프라 설정이 함께 들어가기 시작합니다. 누가 로드밸런서를 만들고, 누가 호스트와 경로를 관리하며, 어떤 팀이 다른 네임스페이스의 서비스에 연결할 수 있는지 구분하기 어려워집니다.

Gateway API는 이런 문제를 해결하기 위해 Kubernetes 생태계에서 제안된 확장 API입니다. 이 글에서는 GatewayClass, Gateway, HTTPRoute를 중심으로 역할을 나누는 방법과 Ingress와의 차이, 실제 YAML 예시, 적용 전 확인할 기준을 정리합니다. 특정 클러스터에서 직접 배포하거나 성능을 측정한 결과가 아니라, Kubernetes와 Gateway API 공식 문서를 바탕으로 개념을 설명합니다.

<section class="quick-answers"><p class="quick-label">먼저 답하면</p><div class="quick-answer"><h3>Q. Gateway API는 Ingress의 새 버전인가요?</h3><p>A. 단순한 버전 업그레이드라기보다, 서비스 네트워킹을 위한 별도의 리소스 모델입니다. Ingress보다 역할 분리와 표현력이 강하고, 기존 Ingress를 한 번에 자동 대체하는 리소스는 아닙니다.</p></div><div class="quick-answer"><h3>Q. Gateway API를 쓰면 컨트롤러가 필요 없나요?</h3><p>A. 필요합니다. Gateway API는 표준 리소스와 동작 규칙을 정의하고, 실제 로드밸런서나 프록시를 구성하는 구현체는 별도로 제공합니다.</p></div><div class="quick-answer"><h3>Q. 모든 Kubernetes 서비스가 바로 지원하나요?</h3><p>A. 구현체마다 지원 범위와 릴리스 채널이 다릅니다. 사용하는 클라우드·Ingress 컨트롤러·서비스 메시의 Gateway API 지원 상태와 conformance 정보를 먼저 확인해야 합니다.</p></div></section>

<figure class="article-figure"><img src="{{ '/assets/images/kubernetes-gateway-api-flow.svg' | relative_url }}" alt="Kubernetes Gateway API 리소스 관계"><figcaption>이미지 출처: ChatGPT 생성</figcaption></figure>

## 1. 외부 트래픽은 어떤 흐름으로 들어오는가

클러스터 외부의 사용자가 `https://api.example.com/orders`에 접근한다고 가정해 보겠습니다. 요청은 DNS와 외부 로드밸런서, Gateway 컨트롤러, 클러스터 내부의 Service와 Pod를 거쳐 애플리케이션에 도착합니다. Kubernetes의 Service는 Pod 집합을 안정적인 네트워크 대상으로 추상화하고, Gateway API는 외부 요청을 어떤 Service로 보낼지 표현하는 역할을 맡습니다.

Ingress를 사용하면 보통 하나의 리소스 안에서 호스트와 경로를 정의합니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop-ingress
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /orders
        pathType: Prefix
        backend:
          service:
            name: order-service
            port:
              number: 8080
```

이 구조는 단순한 라우팅에 적합합니다. 문제는 TLS, 리다이렉트, 가중치, 헤더 기반 라우팅처럼 구현체별 기능이 필요해질 때입니다. Ingress 자체에 없는 기능을 annotation으로 확장하면 설정이 특정 컨트롤러에 종속되고, 다른 구현체로 옮길 때 다시 해석해야 할 수 있습니다.

## 2. Gateway API의 네 가지 핵심 리소스

Kubernetes 공식 문서는 Gateway API의 안정적인 핵심 종류로 GatewayClass, Gateway, HTTPRoute, GRPCRoute를 설명합니다. 각 리소스는 다른 책임을 표현합니다.

### GatewayClass

GatewayClass는 어떤 컨트롤러가 Gateway를 관리하는지 나타냅니다. 인프라 제공자나 클러스터 운영자가 사용할 수 있는 Gateway의 종류를 정의하는 경계입니다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: example-gateway-class
spec:
  controllerName: example.net/gateway-controller
```

`controllerName`은 임의로 적는 이름이 아니라 실제 구현 컨트롤러가 인식하는 값이어야 합니다. 특정 클라우드 로드밸런서나 오픈 소스 게이트웨이 구현체를 선택할 때는 해당 제품의 설치 문서에서 정확한 값을 확인해야 합니다.

### Gateway

Gateway는 실제 트래픽을 받을 네트워크 진입점을 정의합니다. 어떤 GatewayClass를 사용할지, 어떤 포트와 프로토콜을 열지, 어떤 호스트 이름을 받을지를 표현합니다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: public-gateway
  namespace: platform
spec:
  gatewayClassName: example-gateway-class
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: "api.example.com"
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: public
```

여기서 `allowedRoutes`는 중요한 보안·운영 설정입니다. 기본적으로 Gateway는 같은 네임스페이스의 Route를 받는 구조이며, 다른 네임스페이스의 Route를 허용하려면 명시적인 정책이 필요합니다. 모든 네임스페이스의 Route를 무조건 허용하면 팀 간 경계가 약해질 수 있습니다.

### HTTPRoute

HTTPRoute는 애플리케이션 팀이 관리하는 HTTP 라우팅 규칙입니다. 어떤 Gateway에 연결할지, 어떤 호스트와 경로를 매칭할지, 어느 Service로 보낼지를 정의합니다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: order-route
  namespace: orders
spec:
  parentRefs:
  - name: public-gateway
    namespace: platform
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /orders
    backendRefs:
    - name: order-service
      port: 8080
```

이 예시에서는 `orders` 네임스페이스의 HTTPRoute가 `platform` 네임스페이스의 Gateway를 참조합니다. 실제로 연결되려면 Gateway 쪽의 `allowedRoutes`와 Route의 참조 권한이 모두 맞아야 합니다. 단순히 YAML이 존재한다는 것만으로 요청이 라우팅되는 것은 아닙니다.

### GRPCRoute

HTTPRoute가 HTTP 요청을 표현한다면 GRPCRoute는 gRPC 호출을 표현합니다. 프로토콜에 맞는 리소스를 사용하면 특정 구현체의 annotation을 읽어야 하는 상황을 줄이고, 라우팅 의도를 API 구조에 드러낼 수 있습니다. 다만 GRPCRoute나 고급 필터 기능의 지원 수준은 구현체와 릴리스 채널을 확인해야 합니다.

## 3. Gateway API가 역할을 나누는 방식

Gateway API 공식 문서가 강조하는 설계 원칙 중 하나는 role-oriented 모델입니다. 인프라 제공자는 GatewayClass를, 클러스터 운영자는 Gateway를, 애플리케이션 개발자는 HTTPRoute를 주로 관리하는 식으로 책임을 나눌 수 있습니다.

이 구분은 단순히 리소스를 여러 개로 나눈다는 뜻이 아닙니다. 플랫폼 팀은 공통 진입점과 TLS, 네트워크 정책을 관리하고, 서비스 팀은 자신이 소유한 경로와 백엔드를 독립적으로 배포할 수 있습니다. 각 팀이 상대방의 모든 설정을 직접 수정하지 않아도 되므로 변경 권한을 작게 유지할 수 있습니다.

예를 들어 플랫폼 팀은 다음과 같은 정책을 유지할 수 있습니다.

- 외부 HTTPS 리스너는 443 포트만 사용
- 승인된 네임스페이스의 HTTPRoute만 연결
- 공통 인증서와 접근 제어는 Gateway에서 관리
- 애플리케이션 팀은 자신이 소유한 경로만 수정

서비스 팀은 다음 정도만 관리합니다.

- `/orders` 경로를 어떤 Service로 보낼지
- 어떤 호스트 이름을 사용할지
- 필요하다면 트래픽 가중치를 어떻게 나눌지

이 모델은 조직이 커질수록 의미가 있지만, 작은 팀에서는 리소스가 늘어나는 만큼 오히려 복잡하게 느껴질 수 있습니다.

## 4. Ingress와 무엇이 다른가

Kubernetes 공식 문서는 Ingress가 안정적인 API이지만 기능 확장이 제한적이어서 Gateway API 사용을 권장하는 방향을 안내합니다. Gateway API는 공통 기능을 리소스 필드로 표현하고, 구현체별 확장은 별도의 정책이나 확장 리소스로 연결할 수 있습니다.

| 기준 | Ingress | Gateway API |
| --- | --- | --- |
| 기본 역할 | 외부 HTTP·HTTPS 경로 연결 | 진입 인프라와 라우팅 규칙 분리 |
| 설정 구조 | 하나의 Ingress에 규칙 집중 | GatewayClass·Gateway·Route 분리 |
| 팀 권한 분리 | 구현체와 운영 방식에 의존 | 리소스 역할을 기준으로 설계 |
| 확장 방식 | annotation 의존이 많음 | 표준 필드·정책·확장 리소스 |
| 프로토콜 표현 | 주로 HTTP·HTTPS | HTTPRoute·GRPCRoute 등 |
| 이식성 | 컨트롤러별 차이 확인 필요 | conformance와 구현체 지원 범위 확인 |

다만 Gateway API가 모든 이식성 문제를 자동으로 해결하는 것은 아닙니다. 표준 기능은 구현체가 공통으로 지원할 수 있지만, 구현체별 확장 기능과 클라우드 로드밸런서의 동작은 여전히 확인해야 합니다. Gateway API 공식 문서도 구현체의 지원 범위와 conformance 정보를 검토할 것을 안내합니다.

## 5. 트래픽 분할과 점진적 배포

Gateway API의 HTTPRoute는 하나의 규칙에 여러 backendRefs를 둘 수 있고, 구현체가 지원하는 경우 가중치를 활용해 트래픽을 나눌 수 있습니다.

```yaml
rules:
- matches:
  - path:
      type: PathPrefix
      value: /orders
  backendRefs:
  - name: order-service-v1
    port: 8080
    weight: 90
  - name: order-service-v2
    port: 8080
    weight: 10
```

개념적으로는 요청의 90%를 v1, 10%를 v2로 보내는 canary 구조를 표현합니다. 하지만 정확한 분배 방식, 연결 유지, 재시도, 세션 어피니티, 장애 시 동작은 구현체에 따라 달라질 수 있습니다. 이 YAML만으로 실제 트래픽이 정확히 90:10으로 나뉜다고 단정해서는 안 됩니다.

점진적 배포를 운영하려면 라우팅 설정 외에도 오류율, 지연시간, 로그, trace, 롤백 기준을 함께 정해야 합니다. Gateway API는 트래픽을 나눌 수 있는 표준 표현을 제공하지만, 배포 판단 자체를 대신하지는 않습니다.

## 6. 보안과 네임스페이스 경계

Gateway API는 역할별 권한과 Route 연결 관계를 세밀하게 표현하도록 설계되었습니다. 특히 다른 네임스페이스의 Route가 Gateway에 연결될 수 있는지, Route가 다른 네임스페이스의 Service를 참조할 수 있는지를 명시적으로 제한해야 합니다.

운영 전에는 다음을 확인하는 편이 좋습니다.

1. Gateway를 관리할 수 있는 Kubernetes RBAC 권한은 누구에게 있는가?
2. 외부에 노출할 수 있는 네임스페이스는 어디인가?
3. HTTPRoute가 참조할 수 있는 Gateway와 Service의 범위는 어디까지인가?
4. TLS 인증서와 Secret은 어느 팀이 관리하는가?
5. 잘못된 Route가 배포됐을 때 상태 조건과 알림을 어떻게 확인하는가?

Gateway API의 리소스가 분리됐다고 해서 권한도 자동으로 분리되는 것은 아닙니다. Kubernetes RBAC, 네임스페이스 라벨, 컨트롤러 정책, 클라우드 로드밸런서 권한을 함께 설계해야 합니다. Gateway API 보안 문서는 역할별 권한과 cross-namespace 연결에 대한 정책을 별도로 다룹니다.

## 7. 도입 전에 확인할 것

첫 번째는 구현체 지원입니다. Gateway API는 Kubernetes에 기본으로 포함된 단일 데이터 플레인이 아니라 CustomResourceDefinition과 이를 처리하는 컨트롤러의 조합입니다. 사용 중인 NGINX, Envoy Gateway, Istio, 클라우드 로드밸런서 등이 필요한 리소스와 기능을 지원하는지 확인해야 합니다.

두 번째는 릴리스 채널입니다. Gateway API에는 Standard, Experimental 등 기능별 채널이 있습니다. HTTPRoute처럼 안정적인 기능과 아직 구현체별 차이가 큰 기능을 같은 수준으로 취급하면 안 됩니다. 운영 환경에는 안정 채널을 우선 적용하고, 실험 기능은 지원 범위와 롤백 방법을 따로 정해야 합니다.

세 번째는 상태 확인입니다. Gateway와 HTTPRoute에는 Accepted, Programmed, ResolvedRefs 같은 상태 조건이 기록됩니다. 배포 성공 여부를 YAML 적용 명령의 종료 코드만으로 판단하지 말고, 컨트롤러가 리소스를 받아들였는지와 실제 주소가 할당됐는지를 확인해야 합니다.

```bash
kubectl get gatewayclass
kubectl get gateway -A
kubectl get httproute -A
kubectl describe gateway public-gateway -n platform
kubectl describe httproute order-route -n orders
```

네 번째는 기존 Ingress와의 공존입니다. 한 번에 모든 트래픽을 옮기기보다 새로운 호스트나 비중이 작은 서비스부터 Gateway API로 표현하고, DNS·TLS·모니터링·롤백 경로를 확인하는 방식이 안전합니다. 공식 문서도 기존 Ingress를 자동으로 대체하는 것이 아니라 마이그레이션 과정이 필요하다고 설명합니다.

## 8. 한계와 적용 기준 Q&A

<section class="quick-answers"><p class="quick-label">한계와 적용 기준</p><div class="quick-answer"><h3>Q. Ingress가 잘 동작하는데 Gateway API로 반드시 바꿔야 하나요?</h3><p>A. 반드시 그렇지는 않습니다. 현재 요구가 단순한 호스트·경로 라우팅이고 운영 중인 Ingress가 안정적이라면 유지할 이유가 있습니다. 다만 팀 분리, 표준화된 트래픽 분할, gRPC, 구현체 교체 가능성이 중요해지면 Gateway API를 검토할 가치가 커집니다.</p></div><div class="quick-answer"><h3>Q. Gateway API를 도입하면 annotation이 완전히 사라지나요?</h3><p>A. 표준 기능은 annotation 의존을 줄일 수 있지만, 구현체 고유 기능까지 모두 사라지는 것은 아닙니다. 특정 컨트롤러의 확장 정책이나 별도 리소스를 사용할 수 있으므로 이식성을 원하는 범위를 먼저 정해야 합니다.</p></div><div class="quick-answer"><h3>Q. 여러 팀이 Gateway를 공유해도 안전한가요?</h3><p>A. allowedRoutes와 참조 권한을 명시적으로 설계한다면 가능하지만, 무조건 모든 네임스페이스에 열어두는 방식은 피해야 합니다. 플랫폼 팀이 Gateway를 관리하고 서비스 팀은 제한된 HTTPRoute만 관리하는 모델부터 검토할 수 있습니다.</p></div><div class="quick-answer"><h3>Q. 어떤 조직에 특히 적합한가요?</h3><p>A. 여러 팀이 하나의 클러스터를 공유하고, 인프라와 애플리케이션 배포 권한을 나누며, 라우팅 규칙이 복잡해지는 조직에 적합합니다. 단일 팀·단일 서비스·단순한 외부 노출이라면 기존 Ingress가 더 간단할 수 있습니다.</p></div></section>

## 마무리

Gateway API의 핵심은 Ingress보다 리소스가 많다는 사실이 아니라, 트래픽 진입점과 애플리케이션 라우팅 규칙의 책임을 나눌 수 있다는 점입니다. GatewayClass는 컨트롤러와 인프라의 종류를, Gateway는 실제 진입점을, HTTPRoute는 서비스 팀의 라우팅 규칙을 표현합니다.

이 구조는 멀티팀 클러스터와 복잡한 트래픽 정책에서 장점이 있지만, 도입 즉시 모든 문제가 사라지는 기술은 아닙니다. 구현체 지원, 릴리스 채널, cross-namespace 권한, 상태 조건, 관측과 롤백을 함께 설계해야 합니다.

따라서 시작점은 “Ingress를 전부 교체하자”가 아니라 “새로운 서비스 하나의 진입점과 Route 책임을 분리해 볼 수 있는가?”가 적절합니다. 작은 범위에서 컨트롤러의 지원 기능과 운영 모델을 확인한 뒤, 실제 조직의 권한 구조와 맞을 때 점진적으로 넓히는 편이 안전합니다.

### 참고 자료

- [Kubernetes Gateway API 공식 문서](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- [Kubernetes Ingress 공식 문서](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Kubernetes Services·네트워킹 문서](https://kubernetes.io/docs/concepts/services-networking/)
- [Gateway API HTTPRoute 레퍼런스](https://gateway-api.sigs.k8s.io/reference/api-types/httproute/)
- [Gateway API 개념 및 API Overview](https://gateway-api.sigs.k8s.io/concepts/api-overview/)
- [Gateway API 보안 문서](https://gateway-api.sigs.k8s.io/docs/concepts/security/)
