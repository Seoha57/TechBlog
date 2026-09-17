---
layout: post
title: "Kubernetes NetworkPolicy부터 이해하는 워크로드 간 통신 제어"
date: 2026-09-18 08:34:00 +0900
categories: [infrastructure]
tags: [infrastructure, kubernetes, networkpolicy, cni, security, cilium]
description: "Kubernetes Pod 네트워크와 CNI의 기본 개념부터 NetworkPolicy의 ingress·egress, default deny, 점검 방법을 정리합니다."
---

Kubernetes 환경에서 애플리케이션을 여러 Pod로 나누면, 서비스가 정상 동작하기 위해 필요한 통신도 늘어납니다. frontend Pod는 API Pod를 호출하고, API Pod는 데이터베이스·캐시·메시지 브로커·외부 결제 API를 호출할 수 있습니다. 처음에는 “클러스터 안이니 서로 통신되겠지”라고 생각하기 쉽지만, 이것이 곧 “모든 Pod가 모든 Pod와 통신해도 된다”는 뜻은 아닙니다. 한 서비스가 침해되었을 때 다른 서비스로 이동할 수 있는 범위를 줄이고, 실수로 잘못된 엔드포인트를 호출하는 일을 막으려면 워크로드 사이의 네트워크 경계를 설계해야 합니다.

**Kubernetes NetworkPolicy**는 어떤 Pod가 어떤 상대와 어떤 포트·프로토콜로 통신할 수 있는지를 선언하는 Kubernetes API 리소스입니다. ingress는 Pod로 들어오는 트래픽, egress는 Pod에서 나가는 트래픽을 뜻합니다. NetworkPolicy는 방화벽 제품 하나의 이름이 아니라 Kubernetes가 정책을 표현하는 표준 형식이며, 실제로 정책을 적용하려면 이를 지원하는 CNI(Container Network Interface) 네트워크 플러그인이 필요합니다. Kubernetes 공식 문서도 NetworkPolicy를 사용하려면 정책 강제를 지원하는 네트워크 플러그인이 필요하다고 설명합니다. [Kubernetes Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

이 글은 특정 클러스터에 정책을 직접 적용해 보안 효과를 측정한 사례가 아닙니다. Kubernetes 공식 문서와 [Cilium Network Policy 문서](https://docs.cilium.io/en/stable/network/kubernetes/policy/)를 바탕으로, 인프라 기술을 처음 접하는 독자가 NetworkPolicy의 기반 개념과 안전한 도입 순서를 이해하기 위한 학습 글입니다.

<section class="quick-answers"><p class="quick-label">먼저 답하면</p><div class="quick-answer"><h3>Q. NetworkPolicy를 만들면 클러스터 전체 인터넷이 막히나요?</h3><p>A. 아닙니다. 정책이 선택하는 Pod와 정책 유형(ingress, egress)에 대해 허용 범위를 선언합니다. 동작은 CNI 구현과 적용한 정책 조합에 따라 확인해야 하며, DNS 같은 필요한 egress를 빠뜨리면 애플리케이션이 실패할 수 있습니다.</p></div><div class="quick-answer"><h3>Q. Service를 쓰는데도 Pod 통신 정책이 필요한가요?</h3><p>A. Service는 트래픽을 적절한 Pod로 전달하기 위한 추상화이고, NetworkPolicy는 그 통신을 허용할지 제어하는 장치입니다. 역할이 다르므로 Service가 있다고 자동으로 최소 권한 통신이 되지는 않습니다.</p></div><div class="quick-answer"><h3>Q. Cilium을 쓰면 표준 NetworkPolicy와 다른가요?</h3><p>A. Cilium은 표준 Kubernetes NetworkPolicy를 지원하면서, 필요할 때 자체 CRD로 L7 등 더 넓은 정책 표현을 제공합니다. 처음에는 이식성이 높은 표준 NetworkPolicy를 이해하고, 필요한 요구가 생겼을 때 확장 기능을 검토하는 편이 좋습니다.</p></div></section>

## 1. 먼저 알아둘 기반 기술: Pod, Service, CNI

Kubernetes는 컨테이너화된 애플리케이션을 배포·확장·복구하는 오케스트레이션 시스템입니다. **Pod**는 Kubernetes에서 실행되는 가장 작은 배포 단위로, 하나 이상의 컨테이너와 네트워크·스토리지 설정을 함께 가질 수 있습니다. 웹 서버 컨테이너 하나가 Pod 하나로 실행될 수 있고, 로그 수집 같은 보조 컨테이너가 같은 Pod 안에 있을 수도 있습니다.

Pod는 생성·삭제·재배치될 수 있으므로 IP 주소를 고정된 서비스 주소로 직접 쓰기 어렵습니다. **Service**는 label selector로 Pod 집합을 선택하고, 안정적인 이름과 가상 IP를 제공해 다른 Pod가 `orders-api` 같은 이름으로 접근하게 합니다. DNS는 이런 Service 이름을 찾는 데 사용됩니다. 즉 frontend가 `orders-api` Service를 호출하면 실제로는 그 뒤의 여러 API Pod 중 하나로 트래픽이 전달될 수 있습니다.

**CNI(Container Network Interface)** 는 Pod에 네트워크를 연결하고, Pod 사이 통신과 네트워크 정책 적용을 돕는 플러그인 규격·구현 생태계입니다. Kubernetes 자체가 모든 네트워크 패킷을 직접 처리하는 것은 아닙니다. 사용하는 CNI가 NetworkPolicy 강제를 지원하지 않으면 YAML 파일을 적용해도 기대한 차단이 실제로 이루어지지 않을 수 있습니다. 정책을 작성하기 전에 클러스터의 CNI와 지원 범위를 확인해야 하는 이유입니다.

네트워크 보안에서 자주 나오는 **L3/L4/L7**도 간단히 구분해 두면 좋습니다. L3는 IP 주소 수준, L4는 TCP·UDP 포트 수준, L7은 HTTP 경로·메서드·헤더 같은 애플리케이션 수준을 말합니다. 표준 NetworkPolicy는 주로 Pod selector, 네임스페이스 selector, IP block, 포트와 프로토콜을 이용해 L3/L4 통신을 표현합니다. URL 경로나 HTTP 메서드까지 제한하려면 CNI 확장 기능, 프록시, Gateway, 서비스 메시 같은 다른 계층의 도구가 필요할 수 있습니다.

## 2. NetworkPolicy가 실제로 선택하는 것

NetworkPolicy는 이름만 보면 모든 네트워크를 한 번에 제어하는 정책처럼 보이지만, 먼저 `podSelector`로 **대상 Pod 집합**을 선택합니다. 그다음 그 대상에 대해 ingress 또는 egress 허용 규칙을 선언합니다. 그래서 YAML을 읽을 때는 “누가 누구에게 가는가”보다 먼저 “이 정책이 어떤 Pod에 적용되는가”를 확인해야 합니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-api
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: orders-api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
```

이 정책은 `shop` 네임스페이스에서 `app: orders-api` 라벨을 가진 Pod를 대상으로 합니다. 그리고 같은 네임스페이스에서 `app: frontend` 라벨을 가진 Pod가 TCP 8080으로 들어오는 통신을 허용합니다. 여기서 중요한 점은 selector의 네임스페이스 범위입니다. `podSelector`만 쓴 `from`은 정책이 있는 네임스페이스 안의 Pod를 선택하는 의미로 해석됩니다. 다른 네임스페이스의 frontend까지 허용해야 한다면 `namespaceSelector`를 함께 설계해야 합니다.

<figure class="article-figure"><img src="{{ '/assets/images/kubernetes-networkpolicy-flow.svg' | relative_url }}" alt="frontend Pod에서 api Pod로, api Pod에서 database Pod로 필요한 포트만 허용하는 Kubernetes NetworkPolicy 흐름"><figcaption>이미지 출처: 직접 제작</figcaption></figure>

정책은 허용 목록의 조합으로 동작한다고 이해하는 편이 좋습니다. 대상 Pod에 적용되는 ingress 정책이 하나 이상 있으면, 그 Pod의 ingress는 해당 정책들이 허용한 트래픽의 합집합으로 제한됩니다. egress도 같은 방식으로 볼 수 있습니다. 따라서 여러 팀이 같은 Pod에 정책을 추가할 때는 “이 규칙 하나만 읽으면 된다”가 아니라, 모든 관련 정책을 함께 보아야 합니다.

## 3. default deny가 왜 필요한가

정책을 하나도 적용하지 않은 환경에서는 CNI와 기본 구성에 따라 Pod 간 통신이 넓게 허용되는 경우가 많습니다. 여기서 특정 허용 정책만 하나 추가하면, 대상 Pod가 의도대로 격리되는지 이해하지 못해 장애를 만들 수 있습니다. **default deny**는 먼저 대상 Pod의 ingress 또는 egress를 기본적으로 제한하고, 필요한 통신을 허용 규칙으로 추가하는 접근입니다.

아래는 한 네임스페이스의 모든 Pod에 대해 ingress를 제한하는 가장 단순한 예시입니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
    - Ingress
```

`podSelector: {}`는 해당 네임스페이스의 모든 Pod를 선택합니다. ingress 규칙을 비워 두면 선택된 Pod에 들어오는 연결을 기본적으로 허용하지 않는 방향이 됩니다. 그러나 이것만 적용하고 frontend→API, 모니터링, health check, 필요한 운영 접근을 허용하지 않으면 서비스가 바로 실패할 수 있습니다. 그래서 default deny는 한 번에 프로덕션 전체에 적용할 스위치가 아니라, 통신 목록을 먼저 파악하고 좁은 네임스페이스에서 검증하며 확장할 정책입니다.

egress default deny는 더 주의가 필요합니다. 많은 애플리케이션이 외부 API뿐 아니라 DNS 서버를 통해 이름을 해석합니다. egress를 제한한 뒤 DNS 요청을 허용하지 않으면 `orders-api.default.svc` 같은 내부 Service 이름도 해석하지 못할 수 있습니다. 시간 동기화, 인증 제공자, 이미지 레지스트리, 로그·메트릭 전송, 외부 결제 API처럼 예상하지 못한 통신이 있을 수 있으므로, 연결 실패를 단순 애플리케이션 오류로 보지 말고 정책과 DNS부터 확인해야 합니다.

## 4. ingress와 egress를 업무 흐름으로 번역하기

정책 YAML을 먼저 쓰기보다, 서비스 관계를 문장으로 적어 보는 편이 좋습니다. 예를 들어 쇼핑 서비스라면 다음처럼 시작할 수 있습니다.

| 출발 워크로드 | 도착 대상 | 목적 | 포트·프로토콜 | 방향 |
| --- | --- | --- | --- | --- |
| frontend | orders-api | 주문 조회·생성 | TCP 8080 | frontend egress / API ingress |
| orders-api | PostgreSQL | 주문 저장 | TCP 5432 | API egress / DB ingress |
| orders-api | kube-dns | Service 이름 조회 | UDP/TCP 53 | API egress |
| monitoring | orders-api | 메트릭 수집 | TCP 9090 | monitoring egress / API ingress |

같은 연결도 출발 Pod의 egress와 도착 Pod의 ingress 양쪽에서 생각해야 합니다. API Pod가 DB로 나가는 것을 egress 정책에서 허용했더라도, DB Pod의 ingress 정책이 API Pod를 허용하지 않으면 연결이 실패할 수 있습니다. 반대로 DB ingress만 열어 두고 API egress를 제한하면 역시 실패합니다. 어느 한쪽만 본 “통신 다이어그램”보다 방향별 정책 행렬이 도움이 되는 이유입니다.

특히 데이터베이스는 라벨과 namespace가 정확한지 확인해야 합니다. 실제 PostgreSQL이 Kubernetes Pod가 아니라 관리형 DB 서비스라면 `podSelector`로 선택할 수 없습니다. 이 경우 외부 IP 또는 DNS 이름, CNI 기능, 클라우드 보안 그룹·방화벽 같은 별도 경계가 함께 등장합니다. NetworkPolicy만으로 모든 네트워크 보안 요구를 해결할 수 없으며, 클러스터 안의 Pod 통신 제어라는 범위를 분명히 해야 합니다.

## 5. label은 보안 경계의 일부다

NetworkPolicy는 label selector를 많이 사용합니다. 그래서 라벨은 단순한 화면 분류용 메타데이터가 아니라 통신 허용 여부에 영향을 줄 수 있습니다. `app: frontend`, `role: database`, `team: payments` 같은 라벨이 정책과 Deployment에 일관되게 적용되는지 확인해야 합니다.

좋지 않은 예는 너무 넓은 selector입니다. `app: backend`라는 라벨을 여러 서비스가 공유하는데, 그 라벨 하나를 기준으로 결제 API에서 모든 backend 접근을 허용하면 의도보다 넓은 통신이 열릴 수 있습니다. 반대로 지나치게 세부적인 라벨을 selector에 쓰면 Deployment 템플릿 변경 때 정책이 아무 Pod도 선택하지 않는 문제가 생길 수 있습니다. 보안 라벨은 서비스 정체성, 역할, namespace처럼 오래 유지되는 기준으로 설계하고, 배포 버전이나 임시 환경 이름처럼 자주 바뀌는 값과 섞지 않는 편이 좋습니다.

정책을 적용하기 전에는 대상 Pod의 실제 라벨을 확인합니다.

```bash
kubectl get pods -n shop --show-labels
kubectl get networkpolicy -n shop
kubectl describe networkpolicy allow-frontend-to-api -n shop
```

이 명령은 개념을 설명하기 위한 예시입니다. 운영 환경에서 실행할 권한과 출력에 포함되는 정보는 조직 절차를 따라야 합니다. `describe` 결과로 selector와 규칙을 읽는 것만으로 모든 패킷 허용 여부를 확정할 수는 없으므로, CNI의 정책 관찰 도구와 테스트 Pod에서의 연결 확인을 함께 사용할 수 있습니다.

## 6. 테스트는 차단과 허용을 모두 확인한다

NetworkPolicy를 도입할 때 자주 하는 실수는 “차단될 연결”만 시험하는 것입니다. 보안 정책은 막아야 할 연결이 막히는지뿐 아니라, 서비스에 반드시 필요한 DNS·헬스 체크·메트릭·의존 서비스 연결이 계속 되는지도 확인해야 합니다. 다음처럼 허용/차단 행렬을 만들면 QA와 운영팀이 같은 기준으로 검증하기 쉽습니다.

| 테스트 | 기대 결과 | 실패 시 확인할 것 |
| --- | --- | --- |
| frontend → API 8080 | 연결 성공 | Service selector, API ingress, frontend egress |
| 다른 namespace → API 8080 | 연결 실패 | namespace selector 범위, 기존 허용 정책 |
| API → DB 5432 | 연결 성공 | 양방향 정책, DB 주소와 포트 |
| API → 임의 외부 주소 | 정책에 따라 실패 | egress default deny, 필요한 예외 여부 |
| API → DNS 53 | 이름 해석 성공 | DNS namespace·label·UDP/TCP 규칙 |
| monitoring → metrics 9090 | 수집 성공 | 모니터링 Pod 라벨과 포트 |

테스트 환경에서는 임시 Pod를 이용해 `curl`, `nc`, DNS 조회 같은 도구로 연결 여부를 확인할 수 있습니다. 다만 테스트 Pod에 과도한 권한이나 네트워크 도구를 상시 두지 말고, 목적·범위·정리 절차를 정하는 편이 좋습니다. “테스트를 위해 모든 네트워크를 열자”는 방식은 정책 검증의 의미를 잃게 합니다.

## 7. Cilium 같은 확장 기능은 언제 검토하는가

표준 NetworkPolicy는 이식성이 높고 기본적인 Pod·namespace·포트 제어에 적합합니다. 하지만 업무 요구가 HTTP 경로 단위 제한, DNS 이름 기반 egress, 클러스터 전체 우선순위 정책, 더 풍부한 관찰 기능까지 필요로 하면 Cilium 같은 CNI의 확장 정책을 검토할 수 있습니다. Cilium은 표준 NetworkPolicy와 `CiliumNetworkPolicy`, `CiliumClusterwideNetworkPolicy` 같은 형식을 지원하며, 정책 종류를 여러 개 섞을 때 전체 허용 결과를 이해하기 어려워질 수 있다고 문서에서 주의합니다. [Cilium Network Policy](https://docs.cilium.io/en/stable/network/kubernetes/policy/)

예를 들어 L7 HTTP 정책이 필요하다고 해서 표준 NetworkPolicy를 곧바로 모두 Cilium 정책으로 바꿀 필요는 없습니다. 먼저 “특정 HTTP path만 허용해야 하는가”, “기존 API Gateway 또는 서비스 메시가 같은 역할을 하고 있는가”, “운영팀이 정책 우선순위와 장애 조사 방법을 이해할 수 있는가”를 따져야 합니다. 기능이 많아질수록 정책 표현력은 높아지지만, 장애 때 어떤 규칙이 적용됐는지 찾는 비용도 커질 수 있습니다.

## 8. 단계적인 도입 순서

NetworkPolicy는 보안에 유용하지만, 기존에 암묵적으로 허용되던 통신을 드러내는 작업이기도 합니다. 그래서 다음과 같이 단계를 나누는 편이 안전합니다.

1. 현재 namespace와 Service, Pod 라벨, 외부 의존성을 목록화한다.
2. 관찰 도구와 애플리케이션 로그로 실제 통신을 확인한다.
3. 가장 독립적인 서비스 한 곳에 ingress default deny와 필수 허용 규칙을 테스트 환경에서 적용한다.
4. DNS·헬스 체크·메트릭·배치·운영 접근을 포함한 허용/차단 테스트를 수행한다.
5. egress 제한은 외부 의존성을 확인한 뒤 별도 단계로 추가한다.
6. 정책 파일의 리뷰·배포·롤백 절차를 IaC 또는 Git 기반 흐름에 연결한다.

정책을 코드처럼 리뷰할 때는 “이 YAML이 문법상 맞는가”만 보지 않습니다. selector가 실제 Pod를 선택하는가, 새 정책이 기존 정책과 합쳐졌을 때 넓은 허용을 만들지 않는가, 라벨 변경으로 정책 대상이 사라지지 않는가, 운영에서 필요한 트래픽을 빠뜨리지 않았는가를 확인합니다. 정책 파일을 애플리케이션 배포와 함께 버전 관리하면 변경 원인 추적과 롤백이 쉬워질 수 있습니다.

## 9. DNS와 외부 통신이 막히는 이유를 이해하기

egress 정책을 처음 적용한 뒤 애플리케이션 로그에 “host not found”, “temporary failure in name resolution”, “connection timeout” 같은 오류가 보이는 경우가 많습니다. 서비스 코드나 외부 API가 고장 났다고 생각하기 쉽지만, 이름 해석을 담당하는 DNS 통신이 막힌 경우일 수 있습니다. Pod는 `payments-api.payments.svc.cluster.local` 같은 Service 이름을 IP 주소로 바꾸기 위해 보통 클러스터 DNS를 조회합니다. egress default deny를 만들었다면 DNS Pod 또는 DNS Service로 향하는 UDP 53, 필요한 경우 TCP 53 통신도 정책에 포함해야 합니다.

DNS 허용 규칙을 쓸 때도 “53 포트를 전부 열자”보다 대상 범위를 먼저 생각합니다. 클러스터의 DNS가 어느 namespace에서 어떤 label로 실행되는지, 실제 CNI와 DNS 배포 방식이 무엇인지 확인합니다. kube-system namespace의 CoreDNS를 쓰는 클러스터가 많지만, 설치 방식에 따라 이름·label·IP가 다를 수 있습니다. 다른 환경의 YAML을 그대로 복사하면 selector가 아무 Pod도 선택하지 않거나, 반대로 너무 넓은 namespace를 허용할 수 있습니다.

외부 SaaS API를 호출하는 워크로드도 egress 정책에서 까다롭습니다. 표준 NetworkPolicy의 `ipBlock`은 CIDR 범위를 표현하지만, 외부 서비스가 CDN·로드밸런서·가변 IP를 사용하면 IP 목록을 안정적으로 관리하기 어렵습니다. 또한 Kubernetes 공식 문서는 `ipBlock`의 클러스터 내부 IP 처리 방식이 CNI·환경에 따라 다를 수 있음을 주의시킵니다. [Kubernetes Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/) 그래서 외부 연동을 보호하려면 NetworkPolicy만 보지 않고, 클라우드 보안 그룹·NAT·egress gateway·DNS 기반 정책·애플리케이션 수준 인증을 조합할 필요가 있습니다.

예를 들어 결제 API로 HTTPS 443을 나가야 하는 `payments-api` Pod가 있다고 합시다. 요구사항을 문장으로 쓰면 “payments-api만 결제 제공사의 허용된 엔드포인트로 443을 호출한다”가 됩니다. 하지만 표준 정책만으로 도메인 이름의 의미를 직접 표현하기 어렵다면, 실제 네트워크 경계가 IP·NAT·gateway 중 어디에서 강제되는지 정해야 합니다. 이때 ‘443 포트 egress를 전부 허용’하는 결정은 연결 장애를 빠르게 해결할 수 있지만, 정책의 최소 권한 목적을 크게 약화시킬 수 있습니다. 임시 예외인지, 장기 설계인지와 만료·리뷰 책임자를 남겨 두는 것이 좋습니다.

## 10. health check와 운영 도구를 빠뜨리지 않는 방법

Kubernetes 워크로드는 사용자 요청만 처리하지 않습니다. liveness probe와 readiness probe는 Pod가 살아 있는지, 트래픽을 받을 준비가 됐는지 판단하는 데 사용됩니다. 메트릭 수집기는 `/metrics` 엔드포인트를 호출할 수 있고, 로그·보안 에이전트·서비스 메시 프록시·배치 작업도 별도의 통신을 만들 수 있습니다. NetworkPolicy를 설계할 때 애플리케이션의 주 경로만 그리면, 배포 뒤 Pod가 Ready가 되지 않거나 모니터링이 조용히 끊기는 문제를 만들 수 있습니다.

먼저 어떤 검사와 관찰 도구가 어느 위치에서 실행되는지 구분합니다. HTTP probe가 kubelet에서 Pod로 들어오는 구조인지, 별도 monitoring Pod가 Service를 통해 접근하는지, 클라우드 로드밸런서가 노드·Pod에 어떤 방식으로 헬스 체크하는지에 따라 정책 영향이 다릅니다. 모든 환경을 한 규칙으로 설명할 수 없으므로, 사용하는 Kubernetes 배포판·CNI·Ingress 또는 Gateway 구현의 문서를 함께 확인해야 합니다.

운영 접근도 업무 역할에 맞게 제한해야 합니다. “문제 발생 시 디버깅해야 하니 모든 Pod에 관리자 Pod가 접근 가능해야 한다”는 방식은 편하지만 침해 범위를 넓힙니다. 대신 승인된 운영 namespace, 일시적인 디버그 Pod, 제한된 ServiceAccount, 기록이 남는 실행 절차 같은 보완 통제를 생각할 수 있습니다. NetworkPolicy는 RBAC를 대체하지 않지만, RBAC로 누가 디버그 Pod를 만들 수 있는지와 NetworkPolicy로 그 Pod가 어디에 접근할 수 있는지를 함께 설계하면 경계가 더 명확해집니다.

## 11. 배포와 롤백을 포함한 정책 변경 절차

정책은 애플리케이션 코드와 마찬가지로 정상 경로를 깨뜨릴 수 있습니다. 따라서 변경 요청에는 정책 YAML뿐 아니라 영향 범위와 검증 방법을 적는 편이 좋습니다. 예를 들어 “orders-api에 egress default deny를 적용한다”는 변경이라면, 허용할 DNS·PostgreSQL·메시지 브로커·결제 API·메트릭 수집 주소를 목록화하고, 각 통신의 성공·실패 테스트를 붙일 수 있습니다. 정책만 추가하고 “문제 없으면 됨”으로 끝내면 장애 시 무엇을 봐야 할지 알기 어렵습니다.

롤백도 단순히 파일을 삭제하는 것만이 아닐 수 있습니다. 정책을 제거하면 임시로 넓은 통신이 다시 열릴 수 있으므로, 어떤 통신 장애를 복구하기 위한 롤백인지와 다시 제한할 계획을 남겨야 합니다. 반대로 허용 규칙 하나를 급하게 추가하면 의도보다 넓은 selector나 namespace가 들어갈 수 있습니다. 긴급 변경은 필요할 수 있지만, 이후에 정상 변경 절차로 돌아가 정책 범위·만료 시점·테스트를 재검토하는 후속 작업이 필요합니다.

GitOps나 IaC 흐름을 사용하는 경우에는 정책 파일도 애플리케이션 Deployment와 함께 pull request로 리뷰할 수 있습니다. 이때 자동 검증은 YAML 문법, Kubernetes API 버전, selector의 기본 형식, 금지된 광범위한 CIDR 등을 잡는 보조 장치가 될 수 있습니다. 자동 검증이 있다고 해서 실제 연결 테스트를 생략할 수는 없습니다. 정책의 의미는 실제 Pod 라벨, 실행 중인 CNI, 다른 정책의 조합에서 결정되기 때문입니다.

## 12. 사고 대응에서 NetworkPolicy를 어떻게 볼 것인가

보안 사고나 의심스러운 Pod 동작이 발생했을 때 NetworkPolicy는 모든 문제를 해결하는 버튼이 아닙니다. 하지만 감염·오작동한 워크로드가 다른 서비스와 외부로 이동할 수 있는 경로를 줄이는 방어층이 될 수 있습니다. 평소에 서비스별 통신을 좁게 정의해 두면, 예상하지 못한 egress가 발생했을 때 “정상 업무 통신인가?”를 판단할 기준도 생깁니다.

사고 시에는 먼저 어떤 Pod와 namespace가 영향을 받았는지, 그 Pod에 적용되는 ingress·egress 정책이 무엇인지, 최근 정책·라벨·Deployment 변경이 있었는지 확인합니다. 연결을 즉시 모두 막는 조치는 서비스 전체 영향이 클 수 있으므로, 업무 중요도와 침해 징후에 따라 대응 절차를 따릅니다. 보안팀·서비스 담당자·인프라 담당자가 같은 통신 목록과 정책 저장소를 볼 수 있어야 판단 속도가 올라갑니다.

정책 로그나 CNI 관찰 기능이 있는 환경이라면 차단된 흐름과 허용된 흐름을 조사에 활용할 수 있습니다. 그러나 로그에도 URL, 내부 IP, 서비스 이름, 때로는 민감한 메타데이터가 포함될 수 있으므로 보관 기간과 접근 권한을 정해야 합니다. 모든 트래픽을 무제한 수집하는 방식은 비용·개인정보·운영 부담을 키울 수 있습니다. 보안 관찰 역시 필요한 범위와 목적을 명확히 하는 최소 권한 원칙을 적용합니다.

## 13. 정책 리뷰 체크리스트

새 NetworkPolicy를 리뷰할 때 아래 질문을 체크리스트로 활용할 수 있습니다.

| 질문 | 확인 이유 |
| --- | --- |
| `podSelector`가 실제 의도한 Pod만 선택하는가 | 라벨 불일치와 과도한 적용을 막기 위해 |
| ingress와 egress 중 어느 방향을 제한하는가 | 연결의 출발·도착을 혼동하지 않기 위해 |
| 허용 대상이 Pod·namespace·외부 IP 중 무엇인가 | 경계의 수준을 명확히 하기 위해 |
| 필요한 TCP/UDP 포트와 DNS가 포함됐는가 | 정상 서비스 중단을 막기 위해 |
| 기존 정책과 합쳐졌을 때 허용 범위는 무엇인가 | 규칙 하나만 보고 과소평가하지 않기 위해 |
| CNI가 이 기능을 실제로 강제하는가 | 선언만 있고 효과가 없는 상태를 막기 위해 |
| 허용·차단 테스트와 롤백 계획이 있는가 | 변경 실패를 빠르게 발견·복구하기 위해 |

이 체크리스트는 Kubernetes를 잘 아는 사람만을 위한 것은 아닙니다. QA는 기대한 허용·차단 시나리오를 테스트 케이스로 만들 수 있고, 개발자는 자신의 서비스가 실제로 어떤 의존성을 가지는지 확인할 수 있으며, 운영자는 배포 후 어떤 지표를 봐야 하는지 합의할 수 있습니다. NetworkPolicy가 인프라 팀만 관리하는 보안 파일로 고립되지 않을수록 실제 서비스 흐름과 맞는 정책이 될 가능성이 커집니다.

## 14. 처음 적용할 때의 작은 예시

처음 실습 또는 테스트 환경에서 시도할 때는 frontend, API, database처럼 역할이 뚜렷한 세 워크로드를 고르는 편이 좋습니다. 첫 단계에서는 API Pod ingress를 default deny로 만들고 frontend만 TCP 8080으로 허용합니다. 두 번째 단계에서 API Pod egress를 제한하되 DNS와 database 5432를 추가합니다. 세 번째 단계에서 모니터링·배치 같은 실제 운영 통신을 하나씩 추가합니다. 매 단계마다 허용되어야 할 연결과 막혀야 할 연결을 확인하면, 한 번에 큰 정책을 적용하는 것보다 원인을 찾기 쉽습니다.

이 예시는 구조를 이해하기 위한 것이며, 실제 운영의 database가 Pod로 실행된다는 가정을 포함합니다. 관리형 DB·멀티 클러스터·서비스 메시·외부 인증 제공자가 있는 환경에서는 도착 대상과 강제 지점이 달라질 수 있습니다. 그래서 “표준 YAML을 복사해 넣기”보다 자신의 클러스터에서 실제 트래픽이 어디를 지나는지 먼저 그려 보는 것이 더 중요합니다.

### 장애가 난 뒤 확인하는 순서

정책 배포 직후 연결 장애가 발생했다면 가장 먼저 애플리케이션을 재시작하거나 정책을 전부 삭제하기보다, 영향 범위를 좁혀 확인합니다. 문제가 난 Pod의 namespace와 label, 그 Pod를 선택하는 NetworkPolicy, 요청 방향, 대상 Service와 실제 endpoint, DNS 해석 결과를 순서대로 봅니다. 같은 namespace에 적용된 다른 정책도 모두 확인해야 합니다. NetworkPolicy는 여러 규칙의 합집합으로 허용될 수 있으므로, 한 파일만 보고 결론내리기 어렵습니다.

다음으로 CNI가 정책을 실제로 적용하는지와 CNI별 관찰 도구·로그를 확인합니다. YAML이 Kubernetes API에 정상 등록됐다는 사실과 패킷이 차단됐다는 사실은 다릅니다. 마지막으로 테스트 환경에서 같은 Pod 정체성과 namespace를 가진 요청을 재현해, 허용해야 할 연결과 차단해야 할 연결을 각각 확인합니다. 이 순서를 문서화해 두면 긴급 상황에서도 “일단 모든 egress를 열자” 같은 넓은 우회 조치에 의존할 가능성을 줄일 수 있습니다.

정책 문제를 해결했다고 해도 원인은 남깁니다. 누락된 DNS 규칙인지, 잘못된 label인지, 다른 namespace에서 들어오는 모니터링 트래픽인지, CNI 기능 차이인지 기록합니다. 같은 유형의 실수는 다음 정책 리뷰 규칙과 테스트 행렬에 반영할 수 있습니다. 보안 정책도 장애 경험을 통해 더 구체적인 운영 지식으로 발전합니다.

또한 정책의 예외는 시간이 지나면 기본값처럼 남기 쉽습니다. 외부 연동 장애를 해결하려고 임시로 넓힌 egress CIDR, 마이그레이션을 위해 추가한 namespace 허용 규칙에는 목적·담당자·검토 시점을 남겨야 합니다. 정기 리뷰에서 더 좁은 selector나 전용 gateway로 바꿀 수 있는지 확인하면, 서비스가 늘어날수록 정책이 무작정 느슨해지는 일을 줄일 수 있습니다.

NetworkPolicy가 효과를 내려면 애플리케이션 팀도 자신의 의존성을 설명할 수 있어야 합니다. 새 외부 API, 새 메시지 브로커, 새로운 메트릭 수집 경로를 도입할 때 네트워크 요구사항을 변경 요청에 포함하면, 인프라 팀이 배포 뒤 로그만 보고 추측하는 상황을 줄일 수 있습니다. 보안은 막는 담당자의 역할만이 아니라, 필요한 통신을 명확히 말하는 개발 과정의 일부입니다.

처음부터 완벽한 제로 트러스트 구성을 선언하기보다, 실제 서비스 관계를 정확하게 기록하고 작은 범위에서 허용·차단을 검증하는 과정이 더 중요합니다. 정책의 품질은 YAML 줄 수가 아니라, 필요한 통신은 안정적으로 유지하면서 불필요한 통신을 얼마나 명확하게 줄였는지로 판단할 수 있습니다.

이 기준을 공유하면 보안과 가용성 사이의 선택도 감각이 아니라 근거를 가진 리뷰 주제로 바꿀 수 있습니다.

작은 정책 하나부터 꾸준히 개선해 보세요.

## 15. 한계와 적용 기준 Q&A

<section class="quick-answers"><p class="quick-label">한계와 적용 기준</p><div class="quick-answer"><h3>Q. NetworkPolicy만 있으면 Kubernetes 보안이 충분한가요?</h3><p>A. 아닙니다. RBAC, Secret 관리, 이미지 보안, Pod Security, 클라우드 네트워크 경계, 애플리케이션 인증·인가 등과 함께 봐야 합니다. NetworkPolicy는 Pod 통신 범위를 줄이는 한 층입니다.</p></div><div class="quick-answer"><h3>Q. 모든 namespace에 default deny를 바로 적용해도 되나요?</h3><p>A. 권장되지 않습니다. 기존 통신 의존성을 모르면 DNS, 모니터링, 배치, 외부 연동이 중단될 수 있습니다. 작은 범위에서 통신 목록과 테스트를 갖춘 뒤 넓히는 편이 안전합니다.</p></div><div class="quick-answer"><h3>Q. IP 주소만 허용하면 간단하지 않나요?</h3><p>A. Kubernetes Pod IP는 바뀔 수 있고 Service·label 기반 모델과 맞지 않을 수 있습니다. 외부 고정 대상에는 IP 기반 제어가 필요할 수 있지만, 클러스터 내부 워크로드는 label과 namespace 정체성을 먼저 검토하는 편이 일반적입니다.</p></div><div class="quick-answer"><h3>Q. 정책을 적용했는데도 통신이 되는 이유는 무엇인가요?</h3><p>A. CNI가 정책 강제를 지원하지 않거나, selector가 대상 Pod를 선택하지 않았거나, 다른 정책이 허용했을 수 있습니다. 적용된 모든 정책과 CNI 문서, 실제 라벨·namespace를 함께 확인해야 합니다.</p></div></section>

## 마무리: NetworkPolicy는 통신 다이어그램을 실행 가능한 규칙으로 바꾼다

NetworkPolicy의 핵심은 “클러스터 안이니 다 통신해도 된다”는 가정을 줄이는 데 있습니다. 대상 Pod를 선택하고, 필요한 ingress·egress 상대와 포트만 선언하면 서비스 관계가 더 명확해집니다. 하지만 YAML 한 장으로 끝나는 기능은 아닙니다. CNI 지원 여부, DNS와 모니터링 같은 운영 통신, 라벨의 안정성, 허용·차단 테스트, 다른 보안 계층과의 관계를 함께 확인해야 합니다.

처음에는 API Pod 하나의 ingress를 보호하는 작은 정책부터 시작해 보세요. 어떤 Pod가 호출해야 하는지, 어떤 포트가 필요한지, 실패하면 서비스가 어떻게 보이는지를 문서와 테스트로 남깁니다. 그 작은 정책이 쌓이면 네트워크 보안은 추상적인 원칙이 아니라 실제 업무 흐름을 반영한 운영 기준이 될 수 있습니다.

### 참고 자료

- [Kubernetes, Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Kubernetes NetworkPolicy API Reference](https://kubernetes.io/docs/reference/kubernetes-api/networking/network-policy-v1/)
- [Cilium, Network Policy](https://docs.cilium.io/en/stable/network/kubernetes/policy/)
- [Network Policy API Implementations](https://network-policy-api.sigs.k8s.io/implementations/)
