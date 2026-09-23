---
layout: post
title: "SPIFFE·SPIRE로 워크로드 신원을 설계하는 법: mTLS·SVID·증명과 권한 경계"
date: 2026-09-24 08:30:00 +0900
categories: [infrastructure]
tags: [infrastructure, security, zero-trust, spiffe, spire, workload-identity, mtls, kubernetes]
description: "SPIFFE와 SPIRE를 처음 접하는 사람을 위해 워크로드 신원, mTLS, SVID, attestation, Kubernetes·Docker 환경에서의 도입 기준과 한계를 설명합니다."
---

서비스가 늘어나면 “이 요청은 어느 사용자에게서 왔는가”만큼 “이 요청은 어느 프로그램에서 왔는가”가 중요해집니다. 주문 API가 결제 API를 호출할 때 IP 주소가 내부 대역이라는 사실만으로 충분할까요? 같은 클러스터 안의 다른 Pod가 그 주소로 요청을 보냈다면 어떻게 구분할까요? 환경 변수에 넣은 긴 수명의 API 키가 로그나 백업에 남으면 누가 사용했는지 어떻게 추적할까요? 사람 계정의 로그인과 권한 관리만으로는 서버 프로세스·컨테이너·배치 작업 사이의 신원을 안전하게 표현하기 어렵습니다.

**SPIFFE(Secure Production Identity Framework For Everyone)** 는 실행 중인 워크로드에 표준 형태의 신원을 부여하기 위한 오픈 소스 표준과 커뮤니티 프로젝트입니다. 여기서 워크로드(workload)는 웹 서버, 배치 프로세스, Kubernetes Pod, 컨테이너처럼 특정 일을 수행하는 실행 단위를 말합니다. SPIFFE 신원은 보통 `spiffe://신뢰도메인/경로` 꼴이며, 네트워크 위치나 사람이 직접 관리하는 비밀번호 대신 “이 실행 단위가 어떤 조건을 만족해 발급받은 신원인가”를 바탕으로 통신 상대를 확인하게 합니다.

**SPIRE(SPIFFE Runtime Environment)** 는 SPIFFE 표준을 실제 환경에서 발급·검증·배포하도록 구현한 도구입니다. SPIRE Server는 신원 등록과 신뢰 정보를 관리하고, 각 노드의 SPIRE Agent는 자신이 실행되는 환경과 로컬 프로세스를 확인한 뒤 필요한 워크로드에 짧은 수명의 신원 문서(SVID, SPIFFE Verifiable Identity Document)를 전달합니다. Kubernetes, Docker, Unix 같은 실행 환경에서 워크로드가 무엇인지 증명(attestation)하는 방식을 플러그인으로 연결할 수 있다는 점이 핵심입니다.

이 글은 특정 클러스터에 SPIRE를 설치해 운영한 결과가 아닙니다. SPIFFE/SPIRE의 공식 문서와 명세를 바탕으로, 워크로드 신원이 어떤 문제를 줄이고 어떤 문제를 그대로 남기는지 설명합니다. 인증서가 자동으로 발급된다고 해서 권한 정책·비밀 관리·네트워크 보안·애플리케이션 취약점이 자동 해결되는 것은 아니므로, 도입 범위와 운영 책임을 분리해서 봐야 합니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. SPIFFE는 사람 로그인용 OAuth나 SSO를 대체하나요?</h3><p>A. 아닙니다. SPIFFE는 주로 서버·컨테이너·배치처럼 비인간 주체의 신원을 표현합니다. 사람이 화면에 로그인하는 인증과 권한 부여에는 OAuth, OpenID Connect, SSO 같은 별도 체계가 필요할 수 있습니다.</p></div>
  <div class="quick-answer"><h3>Q. mTLS를 쓰면 서비스 간 권한도 자동으로 제어되나요?</h3><p>A. 아닙니다. mTLS는 통신 상대가 가진 신원을 확인하고 구간을 암호화하는 기반입니다. 어떤 SPIFFE ID가 어떤 API·데이터에 접근할 수 있는지는 애플리케이션, 프록시 또는 정책 계층에서 별도로 결정해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. Kubernetes ServiceAccount가 있는데 SPIFFE가 꼭 필요한가요?</h3><p>A. ServiceAccount는 Kubernetes 내부 권한에 매우 유용합니다. 다만 여러 클러스터·VM·Docker·온프레미스 환경을 가로지르는 일관된 서비스 신원, 짧은 수명의 X.509 인증서, mTLS 연동이 필요할 때 SPIFFE/SPIRE를 검토할 이유가 생깁니다.</p></div>
</section>

<figure class="article-figure">
  <img src="{{ '/assets/images/spiffe-spire-identity-path.svg' | relative_url }}" alt="SPIRE 서버와 노드의 SPIRE 에이전트가 워크로드 증명을 거쳐 SVID를 제공하고 두 서비스가 mTLS로 통신하는 흐름">
  <figcaption>이미지 출처: SPIRE의 워크로드 등록·attestation·Workload API 개념을 바탕으로 직접 제작</figcaption>
</figure>

## 먼저 알아둘 기반 기술: 서비스 신원, TLS, mTLS, 비밀값

**신원(identity)** 은 “누구 또는 무엇인가”를 식별하는 표식입니다. 사람이 사번·이메일·계정으로 식별될 수 있듯, 서비스도 이름이 필요합니다. 하지만 Pod 이름, 컨테이너 ID, IP 주소는 신원을 표현하기에 불안정하거나 의미가 부족합니다. Pod는 재시작될 때 이름과 IP가 바뀔 수 있고, 같은 IP를 다른 워크로드가 나중에 사용할 수 있습니다. `payments-api`라는 환경 변수도 누구나 적을 수 있는 문자열이어서, 그 문자열을 가진 프로세스가 진짜 결제 서비스인지 보장하지 않습니다.

**인증(authentication)** 은 제시된 신원이 진짜인지 확인하는 절차이고, **인가(authorization)** 는 인증된 주체가 무엇을 해도 되는지 판단하는 절차입니다. 이 둘은 자주 섞입니다. 예를 들어 결제 API가 클라이언트 인증서를 보고 `spiffe://company.local/prod/orders/api`라는 신원을 확인했다면 인증에 성공한 것입니다. 그 뒤 이 신원이 `POST /payments`를 호출할 수 있는지, 환불은 가능한지, 하루 한도는 얼마인지는 인가 정책의 문제입니다. SPIFFE는 주로 첫 질문을 표준화하며, 두 번째 질문을 대신 정의하지 않습니다.

**TLS(Transport Layer Security)** 는 클라이언트와 서버 사이 통신을 암호화하고 서버의 인증서를 확인하는 프로토콜입니다. 일반 HTTPS에서 브라우저는 서버가 제시한 인증서가 신뢰할 수 있는 CA(Certificate Authority, 인증 기관)에서 발급됐고 도메인 이름에 맞는지 검증합니다. **mTLS(mutual TLS)** 는 여기에 클라이언트도 인증서를 제시해 서버가 클라이언트의 신원까지 검증하는 방식입니다. 따라서 서비스 A가 서비스 B에 연결할 때, B는 “내가 맞는 서버인가”뿐 아니라 “요청한 쪽이 허용된 서비스인가”를 TLS 핸드셰이크에서 확인할 수 있습니다.

인증서는 비밀키(private key)와 공개키(public key)를 이용합니다. 공개키는 배포돼도 되지만 비밀키는 외부에 노출되면 안 됩니다. 장기 인증서나 API 키를 파일·환경 변수·CI 변수에 오래 두면 회전(rotation)과 폐기가 어려워집니다. 누군가 키를 복사해도 만료 전까지 알아차리지 못할 수 있습니다. 짧은 수명의 자격 증명을 자동 발급하고 갱신하면 노출 기간을 줄일 수 있지만, 발급 시스템과 시간 동기화, 장애 시 동작, 신뢰 번들 배포가 새 운영 과제가 됩니다.

마지막으로 **제로 트러스트(zero trust)** 는 내부 네트워크에 있다는 이유만으로 자동 신뢰하지 말고, 요청마다 또는 연결마다 필요한 증거와 최소 권한을 확인하자는 보안 접근입니다. 이것은 특정 제품 하나가 아닙니다. 네트워크 분리, 신원, 정책, 로깅, 기기 보안, 비밀 관리 같은 여러 통제가 함께 작동해야 합니다. SPIFFE/SPIRE는 그중 워크로드 신원과 서비스 간 인증을 다루는 한 조각입니다.

## SPIFFE ID와 SVID는 무엇인가

SPIFFE ID는 URI 형식의 워크로드 이름입니다. 예를 들어 `spiffe://example.org/prod/payments/api`에서 `example.org`은 **trust domain(신뢰 도메인)** 이고, 그 뒤 경로는 조직이 정한 워크로드 식별 경로입니다. URL처럼 보이지만 웹 페이지 주소가 아닙니다. 브라우저에서 열리는 서버를 뜻하지 않고, 특정 신뢰 도메인이 관리·발급한 서비스 신원을 뜻합니다. 이름 설계는 나중의 인가 정책과 감사 로그에 직접 영향을 주므로 단순한 문자열 규칙으로 치부하면 안 됩니다.

신뢰 도메인은 대개 조직 또는 보안 경계를 나타냅니다. 예를 들어 하나의 회사라도 개발·스테이징·운영을 같은 trust domain에 넣을지, 고객 망·법인·리전에 따라 분리할지 정해야 합니다. 너무 넓게 잡으면 한 CA 또는 신뢰 번들의 사고 범위가 커질 수 있고, 너무 잘게 나누면 번들 배포와 연합(federation) 관리가 복잡해집니다. 처음에는 명확한 운영 경계 하나를 선정하고, 다른 환경과 통신해야 할 때 어떤 도메인을 신뢰할지 명시하는 편이 이해하기 쉽습니다.

**SVID**는 SPIFFE ID를 암호학적으로 증명하는 자격 증명입니다. 대표적으로 **X.509-SVID**와 **JWT-SVID**가 있습니다. X.509-SVID는 X.509 인증서의 SAN(Subject Alternative Name)에 SPIFFE ID를 넣어 TLS 연결에서 사용할 수 있도록 합니다. 서비스 메시나 Envoy 같은 프록시, gRPC, TLS 라이브러리와 연결하기 좋습니다. JWT-SVID는 JSON Web Token 형식으로 SPIFFE ID와 audience 같은 정보를 담아 HTTP 헤더나 특정 토큰 검증 흐름에서 사용할 수 있습니다. 어떤 형식이 항상 더 우월하다는 뜻은 아니며, 통신 프로토콜과 재전송 위험, 검증 주체에 따라 선택합니다.

X.509-SVID가 mTLS에서 자주 언급되는 이유는 TLS 핸드셰이크에 자연스럽게 통합되기 때문입니다. 클라이언트와 서버는 서로 인증서를 제시하고, 상대 인증서 체인이 자신이 신뢰하는 번들에 연결되는지, 유효 기간은 맞는지, 기대한 SPIFFE ID인가를 검증합니다. 중간 네트워크 장비가 패킷을 보더라도 TLS 세션과 키 교환의 성질 때문에 단순히 인증서 문자열을 복사해 다른 연결에서 재사용하기 어렵습니다. 반면 JWT는 bearer token 성격을 가질 수 있어 저장·전달·audience 검증을 더 신중히 다뤄야 합니다.

SVID의 생명 주기도 중요합니다. 워크로드가 시작할 때 한 번 인증서를 받아 파일에 영구 저장하는 방식이 아니라, Workload API를 통해 현재 유효한 SVID를 받고 만료 전에 갱신하는 모델을 사용합니다. 애플리케이션이나 프록시는 새 인증서를 감지해 TLS 설정을 reload하거나 메모리에서 교체해야 합니다. 회전이 자동이라는 말은 개발자가 아무것도 하지 않아도 된다는 뜻이 아닙니다. 사용하는 라이브러리·프록시·SDK가 인증서 갱신을 지원하는지, 갱신 실패 때 기존 연결과 새 연결이 어떻게 되는지 테스트해야 합니다.

## SPIRE 구성 요소와 워크로드 증명 흐름

SPIRE는 SPIFFE 표준을 구현하는 런타임입니다. 중앙의 **SPIRE Server**는 등록 항목(registration entry), 신뢰 번들, CA 역할을 관리합니다. 등록 항목은 “어떤 속성을 가진 워크로드에게 어떤 SPIFFE ID를 줄 것인가”라는 매핑입니다. 여기서 속성은 selector라고 부르며, Kubernetes의 namespace·ServiceAccount·Pod label, Docker 컨테이너 속성, Unix UID 같은 환경별 정보가 될 수 있습니다.

각 노드에 배치되는 **SPIRE Agent**는 워크로드가 로컬 Workload API에 접속했을 때 요청한 프로세스가 무엇인지 조사합니다. SPIRE 공식 개념 문서는 Unix에서 Agent가 Unix Domain Socket으로 들어온 요청의 PID(Process ID)를 확인하고, workload attestor 플러그인이 Kubernetes kubelet 같은 주변 플랫폼 구성 요소를 조회해 selector를 얻는 흐름을 설명합니다. Agent는 발견한 selector와 Server에 등록된 항목을 비교해 일치하는 SPIFFE ID의 SVID를 전달합니다.

이 과정을 **workload attestation(워크로드 증명)** 이라고 합니다. 중요한 점은 “컨테이너가 자기 이름을 말했으니 믿는다”가 아니라, Agent가 운영체제·오케스트레이터가 제공하는 관찰 가능한 사실을 토대로 조건을 확인한다는 것입니다. Kubernetes 환경에서는 namespace가 `payments`, ServiceAccount가 `checkout-api`, Pod label이 특정 값인 경우에만 신원을 발급하도록 등록할 수 있습니다. 단, label은 변경 가능하고 클러스터 관리 권한이 탈취될 수 있으므로 selector의 신뢰도는 플랫폼 보안·RBAC·admission policy와 분리해서 생각할 수 없습니다.

**node attestation(노드 증명)** 은 Agent 자신이 올바른 노드 또는 환경에서 실행된 존재임을 Server에 증명하는 단계입니다. 클라우드 인스턴스의 identity document, Kubernetes TokenReview, join token 등 환경에 따라 서로 다른 방식이 있습니다. 이 단계가 약하면 공격자가 가짜 Agent를 등록해 워크로드 신원을 발급받을 수 있으므로, Server와 Agent 사이 신뢰를 어떻게 시작하는지(bootstrap)와 가입 토큰의 전달·만료·회수는 매우 민감한 운영 항목입니다.

Agent가 SVID를 제공하는 Workload API는 보통 로컬 Unix Domain Socket으로 노출됩니다. TCP 포트를 전체 네트워크에 열어 두는 것보다 같은 노드의 프로세스만 접근하게 하기 쉽지만, 소켓 경로와 권한·mount 설정을 잘못 주면 같은 노드의 다른 컨테이너가 자격 증명을 요청할 수 있습니다. Kubernetes에서 CSI Driver나 shared volume으로 SVID를 파일 형태로 제공하는 패턴도 있지만, 파일 권한과 갱신 감지의 책임이 생깁니다. “로컬”이라는 이유만으로 접근 제어를 생략하면 안 됩니다.

## Kubernetes, Docker, VM에서 신원을 다르게 다루는 이유

Kubernetes의 Pod는 빠르게 생성·삭제되고 IP가 바뀝니다. 그래서 namespace, ServiceAccount, workload name처럼 배포 선언과 연결되는 selector가 서비스 신원을 표현하는 데 도움이 됩니다. 다만 namespace가 곧 조직의 보안 경계인지, 여러 팀이 같은 namespace를 쓰는지, ServiceAccount token 접근이 누구에게 허용됐는지는 클러스터 정책에 따라 다릅니다. SPIRE 등록 항목을 만들기 전에 실제 배포 메타데이터의 소유권과 변경 권한을 먼저 확인해야 합니다.

Docker나 단일 VM 환경에서는 Kubernetes metadata가 없으므로 Unix UID, 컨테이너 label, image digest, cgroup path 등 다른 단서를 활용할 수 있습니다. 여기서 중요한 것은 이식성의 양면입니다. SPIFFE ID 형식은 여러 환경에서 같게 유지할 수 있지만, 그 ID를 발급받기 위한 증명 방식은 플랫폼마다 다릅니다. 개발 PC의 Docker 데몬 권한과 운영 Kubernetes의 ServiceAccount는 보안 성질이 같지 않습니다. 동일한 `spiffe://example.org/prod/catalog/api`라는 이름을 쓴다고 해서 같은 수준으로 보호되는 것은 아닙니다.

멀티 클러스터나 하이브리드 환경에서는 **federation(연합)** 을 검토하게 됩니다. 서로 다른 trust domain의 워크로드가 통신하려면 상대 도메인의 신뢰 번들을 받아들이고, 어떤 ID 범위를 신뢰할지 정해야 합니다. 모든 도메인을 무조건 상호 신뢰하면 분리한 의미가 줄어듭니다. 예를 들어 운영 결제 도메인은 분석 도메인의 모든 신원을 신뢰하기보다, 명시적으로 허용된 수집 서비스 한두 개만 신뢰하는 정책이 더 적절할 수 있습니다. 연합은 인증서 파일 하나를 복사하는 작업이 아니라 신뢰 관계를 설계하는 작업입니다.

## mTLS는 연결의 신뢰를 만들고, 인가는 별도로 결정한다

SPIFFE ID를 가진 X.509-SVID로 mTLS를 구성하면 서비스 B는 “요청이 암호화됐고, 상대가 신뢰 도메인이 발급한 `spiffe://.../orders/api`라는 신원을 가졌다”는 사실을 알 수 있습니다. 이 정보는 매우 강력하지만, API 권한 체계 전체가 되지는 않습니다. 주문 API가 결제 API의 `/charge`는 호출해도 `/refund`는 호출하지 못하게 하려면, 경로·HTTP 메서드·메시지 종류·업무 조건을 보는 인가 규칙이 필요합니다.

인가 위치는 여러 곳이 될 수 있습니다. Envoy 같은 프록시나 서비스 메시의 authorization policy에서 source principal과 destination을 비교할 수 있고, 애플리케이션 내부에서 클라이언트 인증서의 SPIFFE ID를 읽어 도메인 규칙을 적용할 수도 있습니다. API Gateway에서 서비스 토큰과 사람 토큰을 구분해 검사할 수도 있습니다. 어느 위치를 선택하든 정책의 원본, 변경 검토, 배포 순서, 감사 로그를 정해야 합니다. 네트워크 정책과도 역할이 다릅니다. NetworkPolicy는 어느 Pod가 어느 Pod·포트와 통신할 수 있는지 제한하고, mTLS/SPIFFE는 연결 상대의 암호학적 신원을 확인합니다.

다음은 정책 의도를 의사 코드로 표현한 예입니다. 특정 제품의 즉시 적용 가능한 설정 파일이 아니며, 신원 확인과 권한 확인이 별개임을 보여 주기 위한 것입니다.

```text
if peer.spiffe_id == "spiffe://example.org/prod/orders/api":
    allow POST /payments/charge
elif peer.spiffe_id == "spiffe://example.org/prod/operations/reconciliation":
    allow GET /payments/settlements
else:
    deny
```

이 규칙에서 위험한 부분도 보입니다. ID 경로 문자열을 애플리케이션마다 하드코딩하면 이름 변경 때 누락이 생길 수 있고, 너무 넓은 prefix 허용은 예상하지 못한 워크로드까지 권한을 줄 수 있습니다. ID를 역할 단위로 발급할지, 서비스 단위로 발급할지, 환경을 경로에 넣을지, 권한 목록을 어디에서 버전 관리할지를 초기에 합의하는 이유입니다. 신원 체계의 성공은 인증서 발급 화면보다 이름·권한·변경 관리가 더 크게 좌우합니다.

## 기존 API 키와 인증서를 옮길 때의 단계적 접근

기존 서비스 간 통신은 흔히 정적 API 키, 기본 인증, 공유 비밀번호, 장기 클라이언트 인증서 중 하나를 사용합니다. 이를 한 번에 제거하면 장애가 날 때 원인을 구분하기 어렵습니다. 먼저 어떤 호출이 존재하는지, 호출자는 사람인지 서비스인지, 키는 어디에 저장되는지, 누가 회전하는지, 키가 노출됐을 때 어떤 범위가 영향 받는지를 목록으로 만드는 것이 우선입니다. 이 단계 없이 새 도구부터 설치하면 오래된 키와 새 SVID가 병행되는 기간이 끝나지 않을 수 있습니다.

첫 도입 대상은 보통 내부 서비스 한 쌍처럼 호출 관계와 owner가 명확하고, 장애 시 롤백 가능한 경로가 좋습니다. 개발 또는 스테이징 trust domain에서 SPIRE Server·Agent의 상태, SVID 갱신, 프록시 reload, 인증 실패 로그를 먼저 확인합니다. 그 뒤 mTLS를 “허용 모드” 또는 관찰 가능한 방식으로 단계적으로 적용하고, 예상과 다른 SPIFFE ID가 들어오는지, certificate expiration 경보가 적절한지, Agent가 재시작되었을 때 새 워크로드가 정상 발급받는지 검증합니다.

정적 키를 즉시 삭제하기 전에 양쪽 경로의 fallback 정책을 정해야 합니다. 인증서 발급 인프라 장애 중에 기존 키로 자동 후퇴하면 가용성은 높아질 수 있지만, 잘못된 키가 계속 사용되거나 공격자가 downgrade를 유도할 위험이 생길 수 있습니다. 반대로 fallback 없이 즉시 차단하면 신원 시스템의 작은 설정 오류가 핵심 결제 흐름을 멈출 수 있습니다. 정답은 시스템 중요도·복구 절차·관찰 가능성에 따라 다르며, 적어도 어떤 상황에서 누가 승인해 예외를 켜는지는 문서화해야 합니다.

비밀 관리도 함께 정리해야 합니다. SPIFFE/SPIRE가 서비스 간 TLS 신원을 제공하더라도 데이터베이스 비밀번호, 외부 SaaS 토큰, 암호화 키까지 자동으로 없애지는 않습니다. Secret manager, Kubernetes Secret, HSM(Hardware Security Module) 같은 도구와 어떤 경계에서 만나는지 정해야 합니다. “SPIFFE를 도입했으니 환경 변수의 모든 비밀을 제거했다”는 식의 과장은 위험합니다. 각각의 자격 증명이 무엇을 증명하고, 어디서 발급하고, 누가 회전하고, 노출 시 어떻게 폐기하는지 따로 관리해야 합니다.

## 운영에서 봐야 할 신호와 장애 시나리오

워크로드 신원 시스템은 보안 도구이면서 동시에 통신 의존성입니다. 그래서 정상 동작만이 아니라 실패를 관찰해야 합니다. Agent가 Server에 연결하지 못할 때 이미 발급된 SVID를 얼마나 제공할 수 있는지, 새 Pod가 기동할 때 SVID가 준비될 때까지 애플리케이션은 어떻게 대기하는지, 인증서 만료가 가까워졌을 때 어떤 경보가 생기는지 확인해야 합니다. 단순히 “Pod Running” 상태만 보면 TLS 핸드셰이크 실패로 실제 요청이 막히는 상황을 놓칠 수 있습니다.

최소한 다음 메트릭과 로그 맥락을 고려할 수 있습니다. SVID 발급·갱신 성공과 실패 수, Agent와 Server 연결 상태, 인증서 만료까지 남은 시간, Workload API 요청 실패, mTLS handshake 실패, 인가 거부 수, 신뢰 번들 갱신 결과, 등록 항목 변경 감사 로그가 있습니다. 보안 정보에는 SPIFFE ID와 namespace가 도움이 되지만, 인증서 개인키·토큰·전체 요청 본문을 로그에 남기면 안 됩니다. 관찰성은 많은 데이터를 모으는 일이 아니라 조사에 필요한 사실을 안전하게 남기는 일입니다.

시간 동기화도 자주 놓치는 의존성입니다. 인증서의 `not before`, `not after` 검증은 시스템 시간이 크게 어긋나면 실패할 수 있습니다. 노드 NTP(Network Time Protocol) 상태, 장시간 중단된 VM, 컨테이너 시간대와 UTC 로그 해석을 운영 점검에 포함해야 합니다. 또 trust bundle을 갱신하는 동안 서로 다른 노드가 새·옛 CA를 어떻게 받아들이는지, 롤링 업그레이드 중 어떤 연결이 재수립되는지도 테스트 환경에서 확인할 가치가 있습니다.

SPIRE Server의 데이터 저장소와 백업·복구 계획도 단순 인프라 문제가 아닙니다. 등록 항목과 CA 상태를 잃으면 새 워크로드에 신원을 발급하지 못하거나, 복구 과정에서 신뢰 체인이 바뀔 수 있습니다. 백업 파일 접근 권한, CA 키 보호, 복구 리허설, Server 고가용성, Agent의 캐시 동작을 서비스 중요도에 맞춰 설계해야 합니다. 작은 실험 환경에서 단일 Server로 시작할 수는 있지만, 그 구성이 운영 서비스의 단일 장애점이 된다는 사실은 분명히 인식해야 합니다.

## 등록 항목은 보안 정책이다: 이름과 selector를 설계하는 법

SPIRE 등록 항목은 단순한 설정 레코드가 아니라 “이 환경 속성을 가진 실행 단위는 이 신원을 받을 자격이 있다”는 보안 정책입니다. 예를 들어 `payments` namespace의 모든 Pod에 결제 서비스 신원을 준다면, 그 namespace에 배포 권한이 있는 주체가 의도하지 않은 Pod를 올려 같은 신원을 받을 가능성을 검토해야 합니다. 반대로 ServiceAccount, workload name, image digest, node 조건을 지나치게 많이 묶으면 정상 배포의 작은 변경도 신원 발급 실패로 이어질 수 있습니다. selector는 넓을수록 편하지만 권한 범위가 넓어지고, 좁을수록 안전하지만 변경 관리 비용이 커집니다.

처음에는 사람이 읽을 수 있는 SPIFFE ID 규칙을 정하는 편이 좋습니다. 예를 들어 `spiffe://회사-운영-도메인/환경/팀/서비스/역할`처럼 경로의 각 요소가 무엇을 뜻하는지 문서화할 수 있습니다. 여기서 환경을 trust domain으로 분리할지, ID path에 넣을지는 하나의 정답이 아니라 신뢰 번들·운영 조직·배포 구조의 선택입니다. 중요한 것은 `payments-api-v2`, `pay-new`, `service123`처럼 변경 때마다 의미가 달라지는 이름을 무계획으로 만들지 않는 일입니다. ID는 인증서, 프록시 정책, 로그, 알림, 감사 기록에 오래 남습니다.

다음은 등록 정책이 표현하려는 관계의 의사 코드입니다. 실제 SPIRE CLI·API 필드와 다르며, 조건과 결과를 읽기 쉽게 보여 주기 위한 예입니다.

```text
조건:
  cluster = production-east
  namespace = payments
  serviceAccount = charge-api
  workloadName = charge-api

발급:
  SPIFFE ID = spiffe://prod.example.org/payments/charge-api
  parent ID = spiffe://prod.example.org/spire/agent/k8s/production-east
  TTL = 조직의 인증서 회전 정책에 따름
```

이 예에서 Kubernetes label만 조건으로 삼지 않고 ServiceAccount와 workload 이름까지 확인하는 이유는, 이름과 권한의 출처를 더 분명하게 하기 위해서입니다. 하지만 selector를 추가한다고 무조건 강해지는 것은 아닙니다. 공격자가 해당 ServiceAccount를 사용할 수 있거나 admission controller가 label 위조를 막지 못한다면 selector가 기대한 보안 성질을 제공하지 못할 수 있습니다. 따라서 등록 항목 리뷰에는 Kubernetes RBAC, 배포 파이프라인 권한, namespace 격리, 이미지 공급망, node 보안 담당자가 함께 참여하는 것이 좋습니다.

또 하나의 설계 선택은 **한 서비스에 하나의 ID를 줄지, 역할마다 ID를 나눌지**입니다. `catalog-api`가 읽기와 쓰기 모두 수행한다면 하나의 ID와 세부 API 인가 정책으로 시작할 수 있습니다. 하지만 같은 이미지가 배치·관리·고객 요청 처리처럼 크게 다른 권한을 수행한다면, 실행 역할별 ServiceAccount와 SPIFFE ID를 분리하는 편이 최소 권한을 표현하기 쉽습니다. 단지 로그를 예쁘게 나누기 위해 ID를 과도하게 세분화하면 등록과 배포가 복잡해질 수 있으므로, 실제 권한 경계가 있는 곳부터 나눕니다.

## 어떤 위협을 줄이고, 어떤 위협은 줄이지 못하는가

SPIFFE/SPIRE는 정적 비밀을 서비스마다 복사하는 문제, IP 주소만으로 호출자를 구분하는 문제, 짧은 수명 인증서를 자동 갱신하기 어려운 문제를 줄이는 데 도움을 줄 수 있습니다. 올바르게 구성된 mTLS는 네트워크 중간에서 평문을 읽거나 서버를 가장하는 위험을 낮추고, 수명이 짧은 SVID는 노출된 자격 증명의 사용 가능 기간을 제한합니다. 서비스가 재배포되어 IP가 바뀌어도 ID를 유지할 수 있어, 프록시 정책과 감사 로그의 의미가 더 안정적이기도 합니다.

하지만 애플리케이션 코드가 SQL injection이나 SSRF(Server-Side Request Forgery)에 취약하면, 유효한 워크로드 신원을 가진 프로세스가 공격자의 명령을 대신 수행할 수 있습니다. 이 경우 mTLS는 공격자가 외부에서 임의의 서비스로 위장하는 것을 어렵게 할 수는 있어도, 이미 권한을 가진 서비스 내부의 취약한 요청을 막지 못합니다. SPIFFE ID가 있는 결제 서비스가 너무 넓은 데이터베이스 권한을 갖고 있다면, 인증이 강해져도 권한 과다는 남습니다. 입력 검증, 네트워크 egress 제어, 데이터베이스 최소 권한, 애플리케이션 보안 테스트가 함께 필요합니다.

또한 노드 또는 클러스터 관리자 권한이 완전히 탈취된 상황을 단순한 SVID 발급 정책만으로 해결하기 어렵습니다. 공격자가 kubelet, container runtime, Agent 소켓, ServiceAccount token, 노드 파일 시스템을 제어할 수 있다면 workload attestation에 사용된 신호 자체를 위조하거나 다른 프로세스로 가장할 가능성을 분석해야 합니다. SPIRE는 다양한 환경에서 증명 플러그인을 제공하지만, 그 플러그인이 믿는 외부 구성 요소까지 포함한 신뢰 경계를 문서화해야 합니다. “Kubernetes 안에 있으니 안전하다”는 가정이 SPIFFE 도입 뒤에도 자동으로 참이 되지는 않습니다.

사람 계정과 서비스 계정을 혼동하는 문제도 남습니다. 사람이 긴급 점검을 위해 운영 API를 호출하는 경우에는 MFA, 승인, 감사, SSO가 필요할 수 있습니다. 서비스가 자동으로 같은 API를 호출하는 경우에는 SPIFFE ID와 workload authorization이 더 적절할 수 있습니다. 한 토큰 형식으로 모두 해결하려고 하면 사람 세션의 탈취·만료 문제와 서버 프로세스의 자동 갱신 문제가 섞입니다. 주체별로 어떤 신원 체계를 쓰는지 표를 만들면 설계가 단순해집니다.

| 주체 | 주로 필요한 신원 | 함께 필요한 통제 |
| --- | --- | --- |
| 직원이 사용하는 웹 화면 | 사람 계정, SSO, MFA | 역할 권한, 세션 만료, 감사 로그 |
| Kubernetes 서비스 | SPIFFE ID와 X.509-SVID | mTLS, API 인가, NetworkPolicy |
| 배치·자동화 작업 | 역할별 SPIFFE ID 또는 관리형 워크로드 ID | 실행 승인, 작업 범위, 로그 보호 |
| 외부 파트너 시스템 | 계약된 클라이언트 인증서 또는 OAuth client | rate limit, API 범위, 키 회전 |

이 표의 목적은 한 제품을 모든 인증의 중심으로 만들자는 것이 아닙니다. 누가 호출하는지와 어떤 위험을 줄이려는지에 따라 적합한 신원 수단을 고르는 것입니다.

## 도입 전·후에 확인할 실전 검증 항목

SPIRE를 설치하기 전에 우선 신원 흐름을 그림으로 그립니다. 호출자 서비스, 대상 서비스, 현재 사용하는 키·인증서, 저장 위치, 발급 주체, 만료 시간, 네트워크 경로, 장애 시 fallback을 한 장에 표시합니다. 이 작업에서 “현재 API 키를 누가 회전하는지 모른다”, “개발과 운영이 같은 인증서를 쓴다”, “서비스가 사실상 사람 관리자 계정을 공유한다” 같은 문제가 먼저 드러날 수 있습니다. SPIFFE는 그런 문제를 해결하는 수단이 될 수 있지만, 목록이 없으면 무엇을 옮겼는지도 판단하기 어렵습니다.

테스트 환경에서는 정상 발급뿐 아니라 실패를 의도적으로 만들어 봐야 합니다. 잘못된 ServiceAccount를 가진 Pod가 기대한 SVID를 받지 못하는가? 다른 namespace의 Pod가 Workload API 소켓을 통해 결제 서비스 신원을 요청할 수 없는가? Agent가 재시작된 뒤 기존 연결과 새 연결은 어떻게 되는가? 신뢰 번들을 변경했을 때 오래 실행 중인 프록시가 새 CA를 받아들이는가? SVID를 갱신하지 못할 때 경보가 충분히 빠르고, 사용자 요청 실패 전 대응할 시간이 있는가? 이런 질문은 도구 설치 성공 화면보다 운영 품질에 더 가깝습니다.

배포 후에는 mTLS handshake 실패를 단순 네트워크 오류로 뭉개지 않도록 로그 필드를 정합니다. source SPIFFE ID, destination SPIFFE ID, trust domain, 인증서 검증 실패 이유, 연결 대상, 배포 버전, namespace·workload 이름은 조사에 도움이 됩니다. 다만 인증서 개인키, 전체 토큰, 요청 본문, 고객 데이터는 이 로그에 넣지 않습니다. 보안 관찰성은 더 많은 내용을 수집하는 것이 아니라, 사고 조사와 권한 검토에 필요한 최소한의 맥락을 신뢰할 수 있게 남기는 일입니다.

마지막으로 철수와 롤백도 설계합니다. 등록 항목을 삭제하면 어떤 서비스가 다음 갱신부터 통신하지 못하는지, 신뢰 번들을 교체하면 어떤 오래된 클라이언트가 실패하는지, 비상시에 mTLS enforcement를 완화하는 것이 가능한지와 그 승인 절차는 무엇인지 정해야 합니다. 보안 통제를 끄는 선택은 때로 가용성 복구에 필요할 수 있지만, 누가 언제 무엇을 끄고 다시 켰는지 남기지 않으면 임시 예외가 영구적인 우회로가 됩니다.

## 한계와 적용 기준 Q&A

<section class="quick-answers">
  <p class="quick-label">한계와 적용 기준</p>
  <div class="quick-answer"><h3>Q. 내부망이라면 SPIFFE/SPIRE 없이 IP 허용 목록만으로 충분한가요?</h3><p>A. 단순한 단일 서버 환경에서는 운영 복잡도가 더 작을 수 있습니다. 하지만 IP가 자주 바뀌고 서비스가 늘어나며, 어느 프로세스가 요청했는지 추적해야 한다면 네트워크 위치만으로 신원을 표현하는 한계가 커집니다.</p></div>
  <div class="quick-answer"><h3>Q. SPIFFE ID를 받은 모든 서비스는 서로 통신해도 되나요?</h3><p>A. 아닙니다. 같은 trust domain의 유효한 신원이라는 사실과 특정 API 권한은 다릅니다. mTLS 성공 뒤에도 source ID·대상·메서드·업무 범위를 보는 최소 권한 정책이 필요합니다.</p></div>
  <div class="quick-answer"><h3>Q. 작은 팀도 바로 SPIRE를 운영해야 하나요?</h3><p>A. 서비스 수가 적고 이미 관리형 mTLS나 클라우드 워크로드 ID가 요구를 충족한다면 SPIRE 운영 비용이 더 클 수 있습니다. 여러 플랫폼을 가로지르는 표준 신원, 직접적인 등록·증명 통제, 복잡한 서비스 간 통신이 필요할 때 검토 가치가 커집니다.</p></div>
  <div class="quick-answer"><h3>Q. SVID가 짧게 만료되면 장애가 줄어드나요?</h3><p>A. 노출된 자격 증명의 유효 기간은 줄일 수 있지만, 갱신 경로와 시간 동기화에 더 의존하게 됩니다. 짧을수록 무조건 안전하다는 식보다, 갱신 실패를 감지·복구할 수 있는 운영 능력에 맞춰 수명을 정해야 합니다.</p></div>
</section>

## 마무리

SPIFFE와 SPIRE는 서비스 간 통신의 질문을 “내부 IP인가?”에서 “이 요청을 보낸 실행 단위는 어떤 신뢰 경계에서 어떤 증거로 신원을 발급받았는가?”로 바꿉니다. X.509-SVID와 mTLS는 암호화된 연결에서 워크로드 신원을 확인하게 하고, Agent와 attestation은 컨테이너가 스스로 주장한 이름이 아니라 환경의 속성을 바탕으로 자격 증명을 주려 합니다.

하지만 신원은 출발점입니다. 어떤 서비스가 어떤 기능을 쓸 수 있는지, 운영 중 인증서 갱신이 실패하면 어떻게 대응하는지, CA와 등록 정보를 어떻게 보호·복구하는지, 정적 비밀은 어디에 남아 있는지를 함께 설계해야 합니다. 처음에는 서비스 한 쌍과 좁은 trust domain에서 SVID 발급·갱신·mTLS 실패 로그를 확인하고, 그 경험을 바탕으로 권한 정책과 플랫폼 범위를 넓히는 편이 안전합니다.

<h3 class="references-heading">참고 자료</h3>

- [SPIFFE — 표준과 프로젝트 소개](https://spiffe.io/)
- [SPIRE Concepts — 등록, selector, workload attestation](https://spiffe.io/docs/latest/spire-about/spire-concepts/)
- [SPIFFE X.509-SVID 표준](https://github.com/spiffe/spiffe/blob/main/standards/X509-SVID.md)
- [SPIFFE JWT-SVID 표준](https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md)
- [SPIRE Workload API 개요](https://spiffe.io/docs/latest/deploying/spire_agent/)
- [NIST SP 800-207 — Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)
