---
layout: post
title: "서비스 장애를 DNS부터 진단하는 법: 리졸버·권한 서버·TTL·캐시·컨테이너 경계"
date: 2026-10-12 08:30:00 +0900
categories: [infrastructure]
tags: [infrastructure, dns, networking, resolver, ttl, kubernetes, docker, troubleshooting]
description: "DNS 장애를 처음 진단하는 사람을 위해 도메인·레코드·리졸버·권한 서버·TTL·캐시의 역할과 컨테이너·Kubernetes 환경에서 이름 해석 문제를 단계적으로 좁히는 방법을 설명합니다."
---

“서비스는 살아 있는데 접속이 안 됩니다”라는 장애 보고에서 DNS(Domain Name System, 도메인 이름 시스템)는 자주 뒤늦게 확인됩니다. 브라우저가 `api.example.com`에 연결하려면 먼저 이름을 IP 주소로 바꿔야 하고, 애플리케이션이 `payment`라는 내부 서비스 이름을 호출하려면 실행 환경의 resolver가 그 이름을 어디에 물어볼지 알아야 합니다. 이 단계가 실패하면 서버 프로세스·포트·방화벽·인증이 모두 정상이어도 사용자는 접속하지 못합니다.

DNS를 단순히 “도메인 주소를 IP로 바꾸는 것”으로만 이해하면, 캐시 때문에 일부 사용자만 오래된 주소로 가는 이유, 운영 노드에서는 되는데 컨테이너 안에서는 이름을 못 찾는 이유, Kubernetes에서 `db`는 안 되지만 `db.prod.svc.cluster.local`은 되는 이유를 설명하기 어렵습니다. DNS는 이름 공간, 위임, 권한 있는 데이터, 재귀 조회, 로컬 캐시, 검색 도메인, 애플리케이션 자체의 연결 재시도 정책이 겹치는 시스템입니다.

이 글은 특정 DNS 제품의 설치법보다 장애를 좁히는 사고 순서에 초점을 둡니다. 외부 사용자 도메인과 사내 private DNS, Docker 컨테이너 이름, Kubernetes Service DNS를 한 가지 개념으로 뭉개지 않고, 누가 어떤 이름을 어떤 resolver에 질의했고 어떤 응답을 받았는지 확인하는 방법을 다룹니다. 실제 운영에서 DNS 레코드를 즉시 바꾸는 작업은 TTL·변경 승인·롤백·보안까지 고려해야 하므로, 명령 예시는 관찰과 재현을 위한 것이며 무단 변경 절차가 아닙니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. DNS가 정상인지 ping만 해 보면 되나요?</h3><p>A. 아닙니다. ping은 ICMP 차단, IPv4/IPv6 선택, 대상 서버 정책의 영향을 받습니다. DNS 자체는 `dig`, `nslookup`, `getent hosts` 등으로 이름·응답 코드·응답 서버·TTL을 확인하고, 그 뒤 TCP/HTTP 연결을 별도로 확인해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. 레코드를 바꾸면 사용자에게 즉시 반영되나요?</h3><p>A. 항상 그렇지 않습니다. recursive resolver, OS, 브라우저, 애플리케이션이 이전 응답을 TTL(Time To Live, 캐시 유효 시간)만큼 보관할 수 있습니다. TTL을 낮춘다고 이미 저장된 캐시가 즉시 사라지지는 않습니다.</p></div>
  <div class="quick-answer"><h3>Q. Kubernetes Service 이름은 외부 DNS에 등록해야 하나요?</h3><p>A. 일반적으로 cluster DNS가 Service와 Pod를 위한 내부 레코드를 제공합니다. Pod의 namespace와 DNS search list에 따라 짧은 이름의 결과가 달라질 수 있으므로, 외부 public DNS 문제와 cluster 내부 서비스 발견 문제를 구분해야 합니다.</p></div>
</section>

## 먼저 알아둘 기반 기술: 이름·IP·포트·프로토콜을 분리한다

네트워크 연결을 한 문장으로 “서버에 접속한다”고 말하면 원인이 섞입니다. 클라이언트는 보통 네 단계를 거칩니다. 첫째 도메인 이름을 IP 주소로 해석합니다. 둘째 그 IP와 TCP 또는 UDP 포트로 패킷을 보냅니다. 셋째 TLS(Transport Layer Security, 전송 계층 보안)라면 서버 이름과 인증서를 검증합니다. 넷째 HTTP·데이터베이스 프로토콜처럼 애플리케이션 규칙에 따라 요청을 보냅니다. DNS는 첫 단계의 핵심이지만, DNS 응답이 정상이라고 HTTP 200이나 로그인 성공까지 보장하지는 않습니다.

**도메인 이름(domain name)** 은 사람이 기억하는 계층적 이름입니다. `api.example.com`에서 오른쪽의 `com`은 최상위 도메인, `example.com`은 그 아래 위임된 영역, `api`는 호스트 또는 서비스 이름으로 볼 수 있습니다. DNS는 이 이름 공간의 데이터를 모두 한 서버가 갖는 구조가 아니라, zone(영역) 단위로 권한을 위임합니다. IETF RFC 1034는 DNS의 도메인 개념과 위임 구조를 설명하는 기본 표준입니다.

**IP 주소**는 네트워크에서 목적지를 찾는 주소입니다. A record는 보통 IPv4 주소를, AAAA record는 IPv6 주소를 제공합니다. CNAME(Canonical Name)은 한 이름이 다른 이름의 별칭임을 나타냅니다. MX는 메일 교환, TXT는 텍스트 기반 검증·정책, SRV는 서비스와 포트 정보를 표현하는 데 쓰입니다. 레코드 타입이 다르면 같은 이름을 조회해도 답이 다를 수 있으므로, “도메인이 안 된다”는 말 대신 어떤 타입의 질의를 했는지 확인해야 합니다.

**포트(port)** 는 하나의 IP에서 여러 네트워크 서비스를 구분합니다. `api.example.com`이 올바른 IP로 해석되어도 443 포트가 열려 있지 않거나 load balancer가 backend로 연결하지 못하면 HTTPS는 실패합니다. 또 TLS는 SNI(Server Name Indication)를 사용해 하나의 IP에 여러 hostname을 배치할 수 있으므로, IP로 직접 접속한 결과가 hostname 접속 결과와 다를 수 있습니다. DNS 장애를 진단할 때 “이름 해석”과 “그 결과로의 연결”을 분리하는 이유입니다.

## 누가 답을 주는가: stub resolver·recursive resolver·authoritative server

애플리케이션이나 OS 안의 **stub resolver(스텁 리졸버)** 는 보통 `/etc/resolv.conf` 또는 운영체제 설정에서 nameserver와 search domain을 읽고, 설정된 recursive resolver에 질의를 보냅니다. 개발자가 `curl https://api.example.com`을 실행할 때 직접 root DNS 서버를 찾아가는 것이 아니라, 대개 회사 DNS·ISP DNS·클라우드 DNS처럼 이미 설정된 resolver에 “이 이름의 IP를 알려 달라”고 묻는 구조입니다.

**recursive resolver(재귀 리졸버)** 는 클라이언트 대신 답을 찾고 캐시하는 서버입니다. 캐시에 결과가 있으면 TTL이 남은 동안 바로 반환하고, 없으면 root·TLD·권한 서버를 따라가 답을 얻습니다. 이 캐시 덕분에 DNS 조회는 빠르고 권한 서버 부하도 줄어들지만, 변경 직후 일부 사용자가 예전 IP를 받는 이유도 됩니다. 회사 VPN 안에서만 이름이 안 풀린다면 회사 resolver의 forwarding·split-horizon 정책을, 일부 리전에만 문제가 있다면 각 네트워크의 resolver 경로를 확인해야 합니다.

**authoritative DNS server(권한 서버)** 는 특정 zone의 공식 레코드를 보유하고 응답하는 서버입니다. `example.com` zone을 관리하는 권한 서버가 `api.example.com`의 A record를 어떤 값으로 갖는지가 원본 데이터에 가깝습니다. `dig @권한서버 api.example.com A`처럼 권한 서버에 직접 물어 최신 원본을 확인할 수 있지만, 일반 사용자가 실제로 사용하는 recursive resolver의 캐시 상태와는 다른 결과가 나올 수 있습니다. 그래서 장애에서는 둘 다 확인해야 합니다.

```text
애플리케이션
  → OS/stub resolver
  → 회사·클라우드 recursive resolver (캐시 확인)
  → root / TLD DNS
  → example.com 권한 DNS (원본 zone)
  → A/AAAA/CNAME 등 응답
  → 얻은 IP:port로 TCP/TLS/HTTP 연결
```

이 경로를 기억하면 “권한 서버에는 새 IP가 있는데 고객은 옛 IP로 간다”는 상황이 모순이 아님을 알 수 있습니다. 원본은 변경됐지만 recursive resolver의 TTL이 끝나지 않았거나, 클라이언트·브라우저·애플리케이션의 별도 캐시가 남았을 수 있습니다. 반대로 모든 resolver가 NXDOMAIN을 받는다면 zone delegation, record 이름, 권한 서버 데이터, 배포 작업을 먼저 의심합니다.

## 응답 코드와 TTL을 읽는 법

DNS 조회 결과는 IP만 읽지 말고 status와 authority 정보를 봐야 합니다. **NOERROR**는 질의가 정상 처리됐다는 뜻이지만, 요청한 레코드 타입의 answer가 반드시 있다는 뜻과는 구별해야 합니다. **NXDOMAIN**은 그 이름 자체가 존재하지 않는다는 의미입니다. **SERVFAIL**은 resolver가 권한 서버와 통신하지 못했거나 DNSSEC 검증·설정 오류 등으로 답을 만들지 못했을 때 볼 수 있습니다. **REFUSED**는 서버가 정책상 질의를 거부했다는 신호일 수 있습니다. 이 차이를 로그에 남기면 “DNS 오류”라는 뭉뚱그린 사건을 실제 담당 경로로 나눌 수 있습니다.

**TTL(Time To Live)** 은 DNS 응답을 캐시해도 되는 시간입니다. 300초라는 TTL은 새로 받은 응답을 보통 최대 5분 동안 재사용할 수 있다는 힌트입니다. 이것은 전 세계의 모든 cache를 한 번에 지우는 원격 제어 명령이 아닙니다. 이미 3600초 TTL로 저장된 응답은 레코드를 60초로 낮춘 뒤에도 기존 만료 시각까지 남아 있을 수 있습니다. planned cutover라면 충분히 앞서 TTL을 낮추고, resolver별 전파 상태와 rollback 시나리오를 준비해야 합니다.

부정 응답도 캐시될 수 있습니다. 이름이 없다는 NXDOMAIN을 짧은 시간 동안 캐시하는 동작을 **negative caching(부정 캐싱)** 이라고 합니다. 막 만든 레코드가 일부 사용자에게 바로 보이지 않는 상황에서는 positive response만이 아니라 이전 NXDOMAIN 캐시 가능성도 검토해야 합니다. RFC 2308은 DNS negative caching을 다룹니다. 단, 구체적인 보관 시간은 zone의 SOA(Start of Authority) 설정과 resolver 구현에 영향을 받으므로 추측 대신 실제 응답을 확인해야 합니다.

```bash
# 현재 설정된 기본 resolver를 통해 A/AAAA와 응답 상태를 본다.
dig api.example.com A
dig api.example.com AAAA

# 특정 resolver가 무엇을 돌려주는지 비교한다.
dig @1.1.1.1 api.example.com A

# CNAME 체인과 최종 answer, TTL을 함께 본다.
dig api.example.com A +noall +answer +authority

# Linux에서 NSS(Name Service Switch)를 거친 실제 이름 해석을 본다.
getent hosts api.example.com
```

위 명령의 결과가 다르면, 어느 환경에서 어느 resolver를 쓰는지 기록합니다. public resolver가 답한다고 해서 회사 VPN의 internal resolver도 같은 zone을 보게 되는 것은 아닙니다. 또한 `getent hosts`는 `/etc/nsswitch.conf`의 hosts 설정을 따를 수 있으므로, DNS만이 아니라 `/etc/hosts` 같은 로컬 정적 항목의 영향을 포함할 수 있습니다. 실제 애플리케이션이 사용하는 라이브러리와 캐시 정책은 또 다를 수 있다는 점을 기억해야 합니다.

## DNS 장애를 좁히는 7단계

DNS 장애는 레코드를 바꾸기 전에 관찰 사실을 모아야 합니다. 다음 순서는 “어떤 팀이 잘못했는지”를 찾기보다, 이름 해석·경로·연결을 가장 작은 실험으로 분리합니다.

1. **정확한 이름과 실패 위치를 적는다.** `api.example.com`인지 `api`인지, browser·batch·container·Pod 중 어디서 실패하는지, 실패 시각과 오류 문자열을 남긴다.
2. **해당 실행 환경의 resolver 설정을 본다.** Linux라면 `/etc/resolv.conf`, Windows라면 `ipconfig /all`, container·Pod라면 내부 파일과 DNS policy를 확인한다.
3. **A와 AAAA를 각각 조회한다.** IPv6 경로만 실패하는지, CNAME이 의도한 target을 가리키는지 확인한다.
4. **응답 코드와 TTL·authority를 기록한다.** NXDOMAIN·SERVFAIL·timeout·오래된 answer는 다음 조사 방향이 다르다.
5. **다른 resolver와 권한 서버 결과를 비교한다.** 원본 zone 문제인지, recursive cache·forwarder 문제인지 가른다.
6. **IP를 얻은 뒤 연결을 별도로 확인한다.** TCP port, TLS SNI/certificate, HTTP health endpoint, load balancer와 backend 상태를 본다.
7. **변경 전후와 캐시 만료 시간을 연결한다.** 최근 DNS 배포, certificate 교체, ingress 변경, VPN 연결, network policy, service rollout 이력을 확인한다.

이 순서는 작은 명령 몇 개만으로도 “DNS가 아니다”를 빨리 증명할 수 있게 해 줍니다. 예를 들어 모든 환경에서 A record가 같은 새 load balancer IP를 반환하고 `curl --resolve`로도 backend 503이 난다면, 사건은 DNS 이후 계층일 가능성이 큽니다. 반대로 특정 Pod에서만 `SERVFAIL`이고 노드에서는 정상이라면 Pod DNS policy, CoreDNS, network policy, upstream forwarding을 좁혀 봐야 합니다.

## 컨테이너의 이름은 호스트의 이름과 다르다

Docker container 안에서 `localhost`는 보통 호스트 PC가 아니라 그 컨테이너 자신입니다. 같은 user-defined bridge network에 연결된 컨테이너는 Docker가 제공하는 내부 DNS로 service/container 이름을 해석할 수 있지만, 이 이름은 인터넷 public DNS에 등록된 도메인이 아닙니다. 호스트에서 `db`가 안 풀리는 것과 container에서 `db`가 안 풀리는 것은 같은 문제로 취급하면 안 됩니다.

Docker Compose에서 `api`와 `db` 서비스가 같은 network에 있다면 애플리케이션은 보통 `db:5432`처럼 서비스 이름으로 DB에 연결합니다. 이때 `db`는 Docker network 안의 발견 이름이고, host에서 접속할 때는 publish한 host port나 별도 DNS가 필요합니다. 컨테이너 내 `/etc/resolv.conf`와 Docker network attachment, service 이름, 실제 connection string을 같이 확인해야 합니다.

```bash
# 컨테이너 안에서 확인한다. 호스트 셸에서 같은 결과가 나올 필요는 없다.
docker exec api getent hosts db
docker exec api cat /etc/resolv.conf
docker exec api sh -c 'nc -vz db 5432'

# 네트워크와 연결된 컨테이너 목록을 확인한다.
docker network inspect app_default
```

여기서 `getent hosts db`가 성공해도 DB 로그인과 쿼리가 성공한다는 뜻은 아닙니다. DNS는 이름을 IP로 바꾼 결과일 뿐이며, container network·port·DB 인증·TLS는 별도 계층입니다. 반대로 host에서 `localhost:5432`가 된다고 컨테이너가 `localhost:5432`로 같은 DB에 닿는 것도 아닙니다. 이 차이를 이해하면 개발 환경에서 흔한 “내 PC에서는 되는데 컨테이너에서는 안 돼요”를 훨씬 빨리 분리할 수 있습니다.

## Kubernetes: namespace와 search domain이 짧은 이름을 바꾼다

Kubernetes는 Service와 Pod를 위해 DNS record를 만들고, kubelet은 Pod가 서비스 이름을 해석할 수 있도록 DNS 설정을 구성합니다. 같은 namespace의 Pod에서 `payments`라고 질의하면 보통 그 namespace의 `payments` Service를 찾습니다. 하지만 `frontend` namespace의 Pod가 `backend` namespace에 있는 Service를 `backend`라고만 호출하면, 자신의 namespace에서 먼저 찾기 때문에 원하는 결과를 받지 못할 수 있습니다. 이때 `backend.backend.svc.cluster.local` 같은 FQDN(Fully Qualified Domain Name, 완전 수식 도메인 이름) 또는 최소한 `backend.backend`처럼 namespace를 포함한 이름이 필요합니다.

Kubernetes 공식 문서는 일반 Service의 DNS A/AAAA record가 Service의 ClusterIP를, headless Service는 selector로 선택된 Pod 집합을 가리킬 수 있다고 설명합니다. 이 차이는 DB cluster나 StatefulSet에서 특히 중요합니다. 일반 Service를 통해 하나의 virtual IP로 접속할 것인지, headless Service가 돌려주는 여러 endpoint를 client가 처리할 것인지는 애플리케이션의 연결·failover 동작과 함께 선택해야 합니다.

```bash
# 문제가 난 Pod 내부에서 확인한다.
kubectl exec -n frontend deploy/web -- cat /etc/resolv.conf
kubectl exec -n frontend deploy/web -- nslookup backend
kubectl exec -n frontend deploy/web -- nslookup backend.backend.svc.cluster.local

# Service와 EndpointSlice가 실제 backend를 가리키는지 확인한다.
kubectl get service -n backend backend -o wide
kubectl get endpointslice -n backend -l kubernetes.io/service-name=backend

# cluster DNS 자체의 상태와 로그는 클러스터 운영 권한 범위에서 확인한다.
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

Pod의 `/etc/resolv.conf`에는 nameserver와 search domain, `ndots` 옵션이 들어갈 수 있습니다. `ndots`와 search list 때문에 짧은 이름 질의가 여러 후보 이름으로 확장될 수 있고, 외부 이름 조회가 느려지거나 예상치 못한 namespace 이름과 충돌할 수 있습니다. 이를 해결하려고 모든 애플리케이션에 임의의 DNS 설정을 주입하기보다, 먼저 실제 질의 이름과 search path를 확인하고, service naming·namespace 경계를 명확히 하는 편이 안전합니다.

## Split-horizon, private DNS, 그리고 보안 경계

**split-horizon DNS** 또는 split-view는 같은 이름에 대해 내부 네트워크와 외부 인터넷에 다른 답을 주는 구성입니다. 예를 들어 외부 사용자는 `portal.example.com`을 public load balancer로 해석하고, 사내 사용자는 private IP 또는 내부 ingress로 해석할 수 있습니다. 이 방식은 private endpoint와 사내 경로를 제공하는 데 유용하지만, VPN 연결 여부·사용하는 resolver·DNS forwarding 경로에 따라 “회사에서는 되는데 집에서는 안 된다” 또는 그 반대의 증상을 만들 수 있습니다.

이 환경에서 public resolver로만 테스트하면 내부 장애를 놓칠 수 있습니다. 장애 보고에는 사용자의 네트워크 위치, VPN 상태, resolver IP, 질의 결과, 응답 TTL과 record type을 포함합니다. 반대로 내부 이름을 public DNS에 우연히 노출하지 않도록 zone 위임·access control·로그를 검토해야 합니다. DNS TXT record에 민감한 설정이나 토큰을 넣는 실수도 피해야 합니다. DNS는 보안 비밀 저장소가 아닙니다.

DNS cache poisoning, 잘못된 delegation, 인증서와 hostname 불일치도 고려해야 합니다. DNSSEC(Domain Name System Security Extensions)는 DNS data의 출처와 무결성 검증을 위한 확장 기술이지만, 도입 여부와 resolver의 검증 동작은 조직의 zone·provider·client 환경에 맞춰 검토해야 합니다. DNSSEC을 켠다고 애플리케이션 인증이나 TLS를 대체하지 않으며, 잘못된 체인은 오히려 SERVFAIL 형태의 장애를 만들 수 있으므로 검증·롤백 계획이 필요합니다.

## 캐시는 한 군데가 아니다: OS·브라우저·애플리케이션·연결 풀

DNS를 바꾼 뒤 한 사용자만 이전 서버에 연결되는 현상은 recursive resolver cache만으로 설명되지 않을 수 있습니다. 운영체제는 name resolution 결과를 캐시할 수 있고, browser는 자체 host cache·connection reuse를 사용할 수 있으며, Java·Go·Node.js 같은 runtime 또는 사용 중인 HTTP client library는 DNS 결과와 connection pool을 별도 정책으로 보관할 수 있습니다. 이미 맺은 TCP/TLS 연결은 DNS를 다시 조회하지 않고 계속 같은 backend로 요청을 보낼 수도 있습니다.

이 때문에 “사용자 PC의 DNS cache를 비우세요”는 최후의 임시 조치일 수는 있어도 근본 설명은 아닙니다. 장애 조사는 애플리케이션이 언제 이름을 재해석하는지, 어떤 resolver를 쓰는지, keep-alive connection을 얼마 동안 유지하는지, load balancer가 이전 backend를 언제 drain하는지까지 살펴야 합니다. 특히 long-lived gRPC, WebSocket, database connection pool처럼 연결을 오래 유지하는 시스템은 DNS TTL이 만료돼도 새 endpoint로 즉시 이동하지 않을 수 있습니다.

테스트할 때는 단일 명령 결과를 일반화하지 말고, 같은 실행 환경에서 DNS 질의와 실제 연결을 연속으로 관찰합니다. `dig`가 새 IP를 반환하는데 애플리케이션 로그의 peer IP는 이전 값이라면, 프로세스 cache·connection pool·proxy를 의심할 수 있습니다. 반대로 새 프로세스를 띄워도 이전 IP에 연결된다면 OS·recursive resolver·split-horizon 경로를 더 깊게 확인합니다. 관찰 시간을 함께 기록해야 cache 만료와 우연한 재연결을 구분할 수 있습니다.

## 모니터링: DNS 성공률만으로는 부족하다

DNS monitoring은 단지 port 53이 열려 있는지 확인하는 것보다 넓어야 합니다. 최소한 다음 신호를 구분해 봅니다. 질의 수와 latency, response code별 비율(NOERROR·NXDOMAIN·SERVFAIL), cache hit·miss, upstream timeout, 권한 서버의 zone transfer 또는 배포 실패, endpoint별 answer 분포, client 환경별 실패율이 그것입니다. private DNS라면 office·VPN·cloud VPC·Kubernetes cluster처럼 서로 다른 resolver 경로에서 synthetic query를 실행하는 것이 도움이 됩니다.

그러나 DNS query 성공만으로 사용자 경험이 정상이라는 결론을 내리면 안 됩니다. `api.example.com`이 올바른 A record를 주는지와 그 IP의 443 TLS handshake가 성공하는지, 기대한 certificate와 HTTP health check가 반환되는지를 함께 봐야 합니다. 외부 synthetic monitoring은 public resolver와 public network에서, 내부 service monitoring은 Pod 또는 private subnet에서 실행해야 실제 사용자의 경로를 재현합니다. 외부 probe 하나만 건강하면 사내 private zone의 오류를 놓칠 수 있습니다.

경보는 증상에 맞춰 분리합니다. NXDOMAIN 급증은 레코드 이름 오타·배포 누락·search domain 문제일 수 있습니다. SERVFAIL 급증은 upstream·DNSSEC·resolver 문제일 수 있습니다. latency 증가는 recursive resolver 과부하·network loss·권한 서버 지연일 수 있습니다. 실제 HTTP 오류 증가는 DNS가 아니라 backend 배포나 인증서 문제일 수 있습니다. 같은 “접속 불가” 경보에 모든 팀을 호출하기보다, 이 분류를 runbook 첫 화면에 두면 초기 대응이 빨라집니다.

## 변경을 안전하게 하는 DNS runbook

DNS record 변경은 짧은 변경이지만 rollback이 즉시 끝나지 않을 수 있습니다. cache와 client connection 때문에 이전·새 값이 일정 기간 공존할 수 있기 때문입니다. 따라서 change request에는 레코드 이름과 타입, 기존·새 answer, TTL, zone과 권한 DNS provider, 영향받는 public/private view, 예정 시각, 이전 endpoint의 유지 기간, 검증 명령, rollback record를 적습니다. A record만 보지 말고 AAAA, CNAME chain, ALIAS/ANAME처럼 provider가 제공하는 별도 동작도 확인합니다.

권장하는 최소 순서는 다음과 같습니다.

1. 변경 며칠 또는 충분한 cache 만료 기간 전에 TTL을 낮추고, 변경 전 높은 TTL이 끝났는지 확인한다.
2. 새 endpoint의 health check, TLS certificate, backend capacity, observability dashboard를 먼저 준비한다.
3. staging 또는 별도 test hostname에서 같은 레코드 타입과 routing을 검증한다.
4. 변경 직후 권한 DNS와 여러 실제 recursive resolver에서 answer·TTL·CNAME chain을 확인한다.
5. public·private·Kubernetes 등 영향 경로에서 DNS뿐 아니라 TCP/TLS/HTTP 또는 업무 probe를 실행한다.
6. rollback 판단 시각까지 이전 endpoint와 로그를 유지하고, 원인을 기록한 뒤 TTL을 정상값으로 되돌린다.

이 runbook에서 핵심은 “새 IP가 한 번 보인다”가 성공 기준이 아니라는 점입니다. 사용자의 resolver 경로에서 새 endpoint가 응답하고, 새 endpoint가 안전하게 요청을 처리하며, 문제가 생겨도 이전 경로로 되돌릴 여지가 남아 있어야 합니다. DNS 관리 콘솔의 변경 이력, infrastructure-as-code 변경, incident timeline을 연결해 두면 나중에 어떤 record가 누가 언제 바꿨는지도 추적할 수 있습니다.

## 재현 가능한 장애 기록을 남기는 형식

DNS incident ticket에 다음 정보를 남기면 다른 담당자가 같은 상태를 재현하는 데 도움이 됩니다. 첫째, 정확한 FQDN과 record type, 사용자가 본 오류 메시지, 발생 시각과 timezone입니다. 둘째, 실패한 client의 네트워크 위치·VPN 여부·Pod namespace·container 이름·resolver 설정입니다. 셋째, `dig` 또는 `nslookup`의 server, status, answer, TTL, authority 결과입니다. 넷째, 같은 시점의 TCP connect·TLS handshake·HTTP status, 최근 DNS·ingress·certificate·network policy 변경입니다.

이 형식은 blame을 위한 것이 아니라 증거를 위한 것입니다. 예를 들어 `backend`라는 이름 하나만 적으면 그것이 local hosts file 항목인지 Docker service인지 Kubernetes Service인지 corporate DNS zone인지 알 수 없습니다. 반면 `backend.payments.svc.cluster.local A`, `frontend namespace Pod`, `10.96.0.10 resolver`, `SERVFAIL`, `CoreDNS upstream timeout`처럼 기록하면 담당 범위를 바로 좁힐 수 있습니다. 로그에는 query name과 client IP가 민감할 수 있으므로, 보관 기간과 접근 권한도 일반 애플리케이션 로그 정책에 맞춥니다.

## 도입 시 흔한 오해와 작은 개선

첫 번째 오해는 모든 internal endpoint에 고정 IP를 쓰면 DNS 문제가 사라진다는 생각입니다. IP를 코드와 환경변수에 박아 두면 이름 해석은 줄어들 수 있지만, endpoint 교체·load balancing·failover·인증서 hostname 관리가 더 어려워질 수 있습니다. stable name과 명확한 service discovery는 변경을 관리하는 장점이 있습니다. 중요한 것은 DNS가 실패할 수 있다는 사실을 전제로 timeouts·retry·fallback·관측을 설계하는 것입니다.

두 번째 오해는 retry를 많이 넣으면 DNS 장애가 해결된다는 생각입니다. 짧은 일시적 timeout에는 제한된 exponential backoff가 도움이 될 수 있지만, NXDOMAIN이나 잘못된 zone delegation을 빠르게 반복 조회하면 부하만 늘고 원인을 숨길 수 있습니다. 애플리케이션은 resolver error를 HTTP 500과 구분해 로그에 남기고, retry 예산·circuit breaker·사용자 메시지를 서비스 특성에 맞게 둬야 합니다. retry 정책은 DNS 팀의 문제를 애플리케이션이 무한히 떠안는 장치가 아닙니다.

세 번째 오해는 cluster 안에서는 DNS가 자동이므로 확인할 필요가 없다는 생각입니다. Kubernetes CoreDNS deployment가 Running이어도 upstream forwarding, network policy, node의 `resolv.conf`, search domain, Service EndpointSlice, Pod의 dnsPolicy 중 하나가 달라질 수 있습니다. Docker에서도 service name이 network에 연결돼 있을 때만 의미가 있습니다. 자동화된 발견 기능일수록 실제 name과 scope를 문서화하고 health check에 포함하는 편이 좋습니다.

## 업무 예시: 새 load balancer 전환 뒤 일부 고객만 이전 서비스로 간다

가상의 서비스가 `api.example.com`을 기존 load balancer에서 새 load balancer로 바꿨다고 하겠습니다. 권한 DNS에는 새 A record가 보이고 운영자 PC에서도 새 IP가 나옵니다. 그러나 일부 고객은 몇 시간 동안 이전 endpoint로 가서 인증 오류를 겪습니다. 이때 “DNS 전파가 늦다”라고만 말하면 다음 변경에서 같은 문제가 반복됩니다.

먼저 cutover 이전의 TTL이 얼마였는지 확인합니다. 이전 응답을 이미 캐시한 recursive resolver는 그 TTL이 끝날 때까지 옛 IP를 줄 수 있습니다. 브라우저나 애플리케이션의 자체 DNS cache, 장기 연결, CDN·proxy도 별도 요인이 될 수 있습니다. 고객이 사용한 resolver와 시간, 받은 IP를 로그로 모으고, 권한 DNS·주요 public resolver·회사 resolver의 결과를 비교합니다. 새 load balancer가 두 IP 모두의 트래픽을 일정 기간 받을 수 있도록 하는 blue/green 또는 overlap 계획이 있었다면, TTL이 만료될 때까지 이전 endpoint를 유지하는 것이 rollback과 사용자 보호에 도움이 됩니다.

다음 전환에서는 변경 직전에 TTL을 낮추는 것이 아니라 충분한 이전 기간을 둡니다. TTL을 낮춘 시점부터 기존 높은 TTL 캐시가 모두 만료될 시간을 계산하고, DNS answer뿐 아니라 certificate, health check, backend capacity, monitoring dashboard, rollback record를 준비합니다. 전환 뒤에는 “새 record가 보인다” 외에 resolver별 answer 비율과 실제 요청이 어느 endpoint에 도착하는지 관찰합니다. DNS 변경은 한 줄의 zone edit이지만 사용자 트래픽 경로 전체의 변경이기 때문입니다.

## DNS와 배포 자동화의 경계

DNS record를 CI/CD(Continuous Integration and Continuous Delivery, 지속적 통합과 전달)로 관리하면 변경 이력과 리뷰를 남길 수 있다는 장점이 있습니다. infrastructure-as-code에서 zone·record·TTL을 코드로 선언하면 수동 콘솔 오타를 줄이고, PR에서 기존 값과 새 값을 비교할 수 있습니다. 하지만 자동화가 DNS cache의 물리적 시간을 없애 주지는 않습니다. 배포 파이프라인이 record 변경 성공을 받았어도 실제 resolver와 사용자 연결의 전환은 TTL·client cache·connection reuse 이후에 관찰될 수 있습니다.

따라서 DNS 변경 단계의 완료 조건을 provider API 성공으로만 두지 않는 편이 좋습니다. 권한 서버 조회, 대표 recursive resolver 조회, public/private synthetic probe, TLS·HTTP health check를 구분해 파이프라인 또는 변경 후 runbook에 넣습니다. 다만 production DNS 변경마다 무조건 자동 rollback을 실행하는 것은 위험할 수 있습니다. 일시적인 resolver 지연이나 관측 실패 때문에 record를 반복 변경하면 더 큰 혼란을 만들 수 있습니다. 사람의 승인 기준과 명확한 error budget을 둔 제한된 자동화가 더 안전합니다.

## 레코드 타입별로 자주 만나는 문제

**A/AAAA** 는 IPv4와 IPv6 경로를 각각 제공하므로, A만 확인하고 AAAA를 잊으면 IPv6 우선 환경에서만 장애가 날 수 있습니다. 새 load balancer가 IPv4만 지원하는데 AAAA가 예전 endpoint를 가리키는 경우도 있습니다. **CNAME** 은 별칭 체인을 만들기 편하지만 chain이 너무 길거나 target의 TTL·존재 여부를 놓치면 진단이 어려워집니다. CNAME의 최종 target까지 `dig` 결과를 확인해야 합니다.

**TXT** 는 도메인 소유 검증, SPF·DKIM처럼 메일 보안, 서비스 설정에 자주 쓰이지만 긴 값의 인용부호·여러 문자열 조각·provider UI의 escaping 차이 때문에 배포 오류가 날 수 있습니다. **SRV** 는 이름과 함께 port·priority·weight를 표현해 특정 프로토콜의 서비스 발견에 쓰일 수 있습니다. Kubernetes도 named port가 있는 Service에 SRV record를 제공할 수 있습니다. 하지만 client library가 SRV를 실제로 해석하는지는 별도 문제이므로, record가 존재한다는 사실만으로 애플리케이션 failover가 된다고 가정하면 안 됩니다.

각 레코드가 어느 서비스 계약을 표현하는지 문서화하면 좋습니다. 예를 들어 `api.example.com A/AAAA`는 외부 API ingress, `_grpc._tcp.catalog.example.com SRV`는 내부 gRPC discovery, `_acme-challenge.example.com TXT`는 certificate validation이라는 식입니다. 이렇게 하면 만료된 TXT 검증값을 지울 때도 어떤 자동화에 영향을 주는지, CNAME을 바꿀 때도 최종 backend와 certificate name이 맞는지 검토할 수 있습니다.

## 장애 훈련에서 확인할 수 있는 작은 시나리오

실제 사용자에게 영향을 주지 않는 staging zone에서 다음과 같은 연습을 해 볼 수 있습니다. 첫째 존재하지 않는 이름을 질의해 NXDOMAIN과 SOA 정보가 어떻게 보이는지 기록합니다. 둘째 권한 DNS의 record와 recursive resolver의 cache가 다른 시점에 어떻게 달라지는지, 안전한 test record의 TTL을 바꾸며 관찰합니다. 셋째 Pod의 다른 namespace에서 short name과 FQDN을 질의해 search domain의 효과를 확인합니다. 넷째 Docker network에서 service name으로 연결한 결과와 host에서 같은 이름을 질의한 결과를 비교합니다.

훈련의 목적은 운영 DNS를 일부러 망가뜨리는 것이 아닙니다. `dig` 출력에서 status·ANSWER·AUTHORITY·ADDITIONAL 섹션을 읽고, “어떤 server가 답했는가”와 “애플리케이션은 그 answer로 무엇을 하는가”를 연결하는 능력을 만드는 것입니다. 담당자가 바뀌어도 같은 순서로 사실을 수집할 수 있도록, 명령 자체보다 결과 해석과 escalation 기준을 runbook에 남기는 편이 중요합니다.

이런 연습에서 나온 결과는 환경별 DNS 지도로 정리할 수 있습니다. public, office, VPN, cloud VPC, container, Kubernetes Pod가 각각 어느 resolver와 search domain을 쓰는지 한 장에 적으면, 실제 장애 때 추측보다 비교를 먼저 할 수 있습니다. DNS의 복잡성은 사라지지 않지만 관찰 위치를 잃지 않게 됩니다.

## 한계와 적용 기준 Q&A

### Q. `nslookup`이 성공했으니 서비스 문제는 DNS가 아닌가요?

A. 이름 해석 문제일 가능성은 낮아질 수 있지만, 같은 애플리케이션이 같은 resolver·record type·network 경로를 쓰는지 확인해야 합니다. 그리고 DNS 성공 뒤에도 TCP port, TLS SNI와 인증서, load balancer, backend, 인증·권한 문제가 남습니다. DNS와 연결·프로토콜을 분리해 점검해야 합니다.

### Q. 장애가 나면 TTL을 0으로 낮추면 바로 해결되나요?

A. TTL을 0 또는 매우 낮게 설정해도 이미 캐시된 응답을 즉시 지우지는 못합니다. provider·resolver·클라이언트 구현도 다를 수 있습니다. 긴급 변경은 새·이전 endpoint의 공존, cache 만료 시간, health check, rollback record, 사용자 영향 공지를 함께 계획해야 합니다. 상시 TTL을 지나치게 낮추면 resolver와 권한 DNS의 질의량·지연이 늘 수 있습니다.

### Q. Kubernetes에서 Service IP가 바뀌면 애플리케이션을 재배포해야 하나요?

A. 일반적으로 Service DNS 이름을 사용하고 연결을 새로 맺는 애플리케이션이라면 DNS가 가리키는 stable service name을 통해 동작하도록 설계할 수 있습니다. 하지만 애플리케이션이 IP를 캐시하거나 장기 연결을 유지하거나 headless Service의 endpoint를 직접 처리한다면 동작이 달라질 수 있습니다. 실제 client library의 DNS cache·connection pool 정책과 Service 유형을 함께 확인해야 합니다.

### Q. public DNS와 private DNS에 같은 이름을 쓰는 것은 항상 나쁜가요?

A. 반드시 나쁜 것은 아니며 split-horizon은 유용한 패턴일 수 있습니다. 다만 VPN·office·cloud workload별 resolver 경로와 답이 달라져 진단·문서화가 어려워질 수 있습니다. 동일 이름을 쓸 이유, 각 view의 소유자, 변경 절차, 모니터링 위치, 외부 노출 금지 규칙을 명확히 할 수 있을 때 적용하는 편이 좋습니다.

## 마무리

DNS 장애를 잘 다루는 출발점은 이름이 IP로 바뀌는 한 순간만 보지 않는 것입니다. 어떤 실행 환경이 어떤 stub resolver와 recursive resolver를 통해 어떤 권한 서버의 데이터를 받았는지, 그 결과가 TTL과 cache 때문에 언제까지 유지되는지, 그리고 얻은 IP에 실제 TCP·TLS·HTTP 연결이 되는지를 분리해야 합니다.

장애 때는 레코드를 급히 바꾸기 전에 정확한 hostname, resolver 설정, 응답 코드, A/AAAA와 CNAME, TTL, 권한 서버와 실제 client resolver의 차이를 기록하세요. 컨테이너와 Kubernetes에서는 host·container·Pod가 같은 이름을 다른 search domain과 DNS server로 해석할 수 있다는 점을 특히 기억해야 합니다. 이 관찰 순서를 갖추면 DNS는 막연한 “전파 문제”가 아니라 재현·설명·복구할 수 있는 인프라 계층이 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [IETF, RFC 1034: Domain Names - Concepts and Facilities](https://datatracker.ietf.org/doc/html/rfc1034)
- [IETF, RFC 1035: Domain Names - Implementation and Specification](https://datatracker.ietf.org/doc/html/rfc1035)
- [IETF, RFC 2308: Negative Caching of DNS Queries](https://datatracker.ietf.org/doc/html/rfc2308)
- [Kubernetes Docs, DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Kubernetes Docs, Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [Docker Docs, Networking overview](https://docs.docker.com/engine/network/)
